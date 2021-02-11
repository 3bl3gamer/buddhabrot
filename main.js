import { controlDouble } from './control.js'
import { initUI, updateRotationInputs } from './ui.js'
import {
	mustBeInstanceOf,
	FPS,
	getById,
	mustBeNotNull,
	SubRenderer,
	matrixFill,
	matrixLerp,
	matrixApply3d,
	matrixFill3d,
	matrixDistance,
	Avg,
} from './utils.js'

// TODO:
// brightness + contrast
// autoincrease coreSamplesSlow if updateImageData is slow on current resolution
// autoincrease curRedrawInterval if updateImageData is slow on current resolution

class RenderCore {
	constructor() {
		this.avgRenderDiff = new Avg(45)
		this.allSubRederers = Array(navigator.hardwareConcurrency)
			.fill(0)
			.map((_, i) => new SubRenderer(i))
		// Rendering with allSubRederers (all available cores) will (theoretically)
		// provide maximum performance. BUT! When animating, each thread should render
		// exactly once. It will be ok if all cores are same and idle. But they are often not.
		// Some of them may be virtual (hypertrading), some of them may be slow (power-efficient
		// mobile cores), some of them may be just busy.
		// So, for maximum *animation* performance we reduce threads count.
		// This array contains those "reduced" renderers (subset of allSubRederers).
		this.animationSubRederers = this.allSubRederers.slice()
	}
	_tryReduceAnimSubRenderers() {
		if (this.animationSubRederers.length - 1 < this.allSubRederers.length / 2) return
		this.animationSubRederers.pop()
		this.avgRenderDiff.clear()
	}
	_tryIncreaseAnimSubRenderers() {
		if (this.animationSubRederers.length === this.allSubRederers.length) return
		this.animationSubRederers.push(this.allSubRederers[this.animationSubRederers.length])
		this.avgRenderDiff.clear()
	}
	adjustAnimSubRenderersCount() {
		const times = this.animationSubRederers.map(x => x.lastRenderDuration).sort((a, b) => a - b)
		this.avgRenderDiff.add(times[times.length - 1] / times[0])
		if (this.avgRenderDiff.hasAtLeast(10)) {
			const value = this.avgRenderDiff.value()
			// if difference between the slowest and the fastest renders is too large,
			// reducing animation threads count
			if (value > 1.55) this._tryReduceAnimSubRenderers()
			// if difference is VERY large, reducing even more
			if (value > 1.75) this._tryReduceAnimSubRenderers()
			// if difference is small, increasing animation threads count
			if (value < 1.35) this._tryIncreaseAnimSubRenderers()
		}
		window.testBox.textContent =
			(this.avgRenderDiff.hasAtLeast(10) ? '+' : '-') +
			this.avgRenderDiff.value().toFixed(2) +
			'|' +
			times.map(x => x.toFixed(0)).join(',')
	}
}

/**
 * @param {RenderCore} renderCore
 * @param {AbortSignal} abortSignal
 * @param {WasmCore} wasm
 * @param {HTMLCanvasElement} canvas
 * @param {Float64Array} mtx
 */
async function runRendering(renderCore, abortSignal, wasm, canvas, mtx) {
	const rc = mustBeNotNull(canvas.getContext('2d'))
	const w = canvas.width
	const h = canvas.height

	const buf = wasm.getInBufView(w, h)
	wasm.clearInBuf(w, h) //works a bit faster than buf.fill(0) in FF

	const coreIters = 250
	const coreSamplesFast = 50 * 1000
	const coreSamplesSlow = 250 * 1000

	console.time('full render')
	console.time('actual render')
	const redrawInterval = 500
	let lastRedrawAt = Date.now()
	let samplesRendered = 0
	let samplesNotYetOnCanvas = 0
	const promises = []
	for (let sample = 0; sample < 128; sample++) {
		const isAnimating = sample < renderCore.animationSubRederers.length * 2
		const subRederers = isAnimating ? renderCore.animationSubRederers : renderCore.allSubRederers

		if (abortSignal.aborted) break

		let freeSub =
			subRederers.find(x => !x.isWorking()) ?? //fast search
			(await Promise.race(subRederers.map(x => x.wait().then(() => x)))) //slower search + wait

		if (abortSignal.aborted) break

		const coreSamples = isAnimating ? coreSamplesFast : coreSamplesSlow
		const seed = freeSub.id * 1000 + sample
		const promise = freeSub.render(w, h, seed, coreIters, coreSamples, mtx).then(() => {
			freeSub.addBufTo(buf)
			samplesRendered++
			samplesNotYetOnCanvas++
			// should not update image before each render thread has rendered at least once (to avoid flickering)
			if (samplesRendered >= subRederers.length) {
				// reducing first redraws interval to make transition between noisy->smooth more... smooth
				const curRedrawInterval =
					redrawInterval * Math.min(1, samplesRendered / subRederers.length / 20)
				if (Date.now() - lastRedrawAt > curRedrawInterval || samplesRendered === subRederers.length) {
					wasm.updateImageData(rc, 0, 0, w, h)
					lastRedrawAt = Date.now()
					samplesNotYetOnCanvas = 0
				}
			}
			promises.splice(promises.indexOf(promise), 1)
		})
		promises.push(promise)
	}
	await Promise.all(promises)

	// if each thread had rendered once and then rerender request has come
	if (samplesRendered === renderCore.animationSubRederers.length) {
		renderCore.adjustAnimSubRenderersCount()
	}

	console.timeEnd('actual render')
	if (samplesNotYetOnCanvas > 0) wasm.updateImageData(rc, 0, 0, w, h)
	console.timeEnd('full render')
}

/**
 * @typedef {Object} WasmCore
 * @prop {(w:number, h:number) => Uint32Array} WasmCore.getInBufView
 * @prop {(w:number, h:number) => void} clearInBuf
 * @prop {(rc:CanvasRenderingContext2D, x:number, y:number, w:number, h:number) => void} WasmCore.updateImageData
 */

async function initWasm() {
	const importObject = {
		env: {
			math_pow: Math.pow,
		},
	}
	const { instance } = await WebAssembly.instantiateStreaming(fetch('./image_data.wasm'), importObject)
	const exports = instance.exports

	const WA_memory = mustBeInstanceOf(exports.memory, WebAssembly.Memory)
	const WA_get_required_memory_size = /** @type {(w:number, h:number) => number} */ (exports.get_required_memory_size)
	const WA_prepare_image_data = /** @type {(w:number, h:number, step:number) => void} */ (exports.prepare_image_data)
	const WA_clear_in_buf = /** @type {(w:number, h:number) => number} */ (exports.clear_in_buf)
	const WA_get_in_buf_ptr = /** @type {() => number} */ (exports.get_in_buf_ptr)
	const WA_get_out_buf_ptr = /** @type {(w:number, h:number) => number} */ (exports.get_out_buf_ptr)

	function ensureMemSize(w, h) {
		const delta = WA_get_required_memory_size(w, h) - WA_memory.buffer.byteLength
		const deltaPages = Math.ceil(delta / 65536)
		if (deltaPages > 0) WA_memory.grow(deltaPages)
	}

	return /** @type {WasmCore} */ ({
		getInBufView(w, h) {
			ensureMemSize(w, h)
			return new Uint32Array(WA_memory.buffer, WA_get_in_buf_ptr(), w * h * 3)
		},
		clearInBuf(w, h) {
			ensureMemSize(w, h)
			WA_clear_in_buf(w, h)
		},
		updateImageData(rc, x, y, w, h) {
			ensureMemSize(w, h)
			const step = w <= 256 ? 1 : w <= 512 ? 2 : w <= 1024 ? 3 : 4
			WA_prepare_image_data(w, h, step)
			const WA_pix = new Uint8ClampedArray(WA_memory.buffer, WA_get_out_buf_ptr(w, h), w * h * 4)
			const imgData = new ImageData(WA_pix, w, h)
			rc.putImageData(imgData, x, y)
		},
	})
}

;(async () => {
	const canvas = getById('main-canvas', HTMLCanvasElement)
	const orientCanvas = getById('orientation-canvas', HTMLCanvasElement)
	const renderCore = new RenderCore()

	const fpsBox = getById('fps-box', HTMLSpanElement)
	const fps = new FPS(fps => (fpsBox.textContent = fps.toFixed(1)))

	const mtx = new Float64Array(8)
	const transition = { fromMtx: new Float64Array(8), startStamp: 0, endStamp: 0 }
	let rotX = 0
	let rotY = 0
	let prevX = null
	let prevY = null

	const wasm = await initWasm()

	controlDouble({
		startElem: canvas,
		callbacks: {
			singleDown(e, id, x, y, isSwitching) {
				prevX = x
				prevY = y
				return true
			},
			singleMove(e, id, x, y) {
				rotY -= (x - prevX) * 0.01
				rotX += (y - prevY) * 0.01
				if (rotX < -Math.PI / 2) rotX = -Math.PI / 2
				if (rotX > Math.PI / 2) rotX = Math.PI / 2
				rotY = (rotY + Math.PI * 2) % (Math.PI * 2)
				prevX = x
				prevY = y
				requestRedraw()
				updateRotationInputs(rotX, rotY)
				return true
			},
			singleUp(e, id, isSwitching) {
				prevX = null
				// requestRedraw()
				return true
			},
		},
	})

	let redrawPromise = Promise.resolve()
	let redrawAbort = new AbortController()
	let redrawRequested = 0
	function requestRedraw() {
		if (redrawRequested >= 2) return
		if (!redrawAbort.signal.aborted) redrawAbort.abort()
		const newAbort = (redrawAbort = new AbortController())
		redrawRequested++
		redrawPromise = redrawPromise
			.catch(() => {})
			.then(() => redraw(newAbort.signal))
			.then(() => fps.frame())
			.finally(() => {
				redrawRequested--
			})
	}
	/**
	 * @param {AbortSignal} abortSignal
	 */
	async function redraw(abortSignal) {
		matrixFill(mtx, rotX, rotY, opts.rotationMode)
		if (transition.endStamp > Date.now()) {
			const duration = transition.endStamp - transition.startStamp
			const delta = Date.now() - transition.startStamp
			let k = delta / duration // linear 0-1
			k = (1 - Math.cos(Math.PI * k)) / 2 // ease in-out 0-1
			matrixLerp(mtx, transition.fromMtx, mtx, k)
			requestAnimationFrame(requestRedraw)
		}
		// rotY += 0.01
		// requestAnimationFrame(requestRedraw)
		redrawOrientation()
		await runRendering(renderCore, abortSignal, wasm, canvas, mtx)
	}
	function resizeOrientation() {
		const s = devicePixelRatio
		orientCanvas.style.width = ''
		orientCanvas.style.height = ''
		const rect = orientCanvas.getBoundingClientRect()
		orientCanvas.width = Math.round(rect.width * s)
		orientCanvas.height = Math.round(rect.height * s)
		orientCanvas.style.width = orientCanvas.width / s + 'px'
		orientCanvas.style.height = orientCanvas.height / s + 'px'
		redrawOrientation()
	}
	function drawOrientationAxis(rc, mtx, dx, dy, dz, label, color) {
		rc.strokeStyle = color
		rc.beginPath()
		rc.moveTo(0, 0)
		rc.lineTo(...matrixApply3d(mtx, dx, dy, dz))
		rc.stroke()

		rc.fillStyle = color
		rc.textAlign = 'center'
		rc.textBaseline = 'middle'
		const [x, y] = matrixApply3d(mtx, dx * 1.1, dy * 1.1, dz * 1.1)
		rc.strokeStyle = 'black'
		rc.lineWidth = 2
		rc.strokeText(label, x, y)
		rc.lineWidth = 1
		rc.fillText(label, x, y)
	}
	function redrawOrientation() {
		const s = devicePixelRatio
		const w = orientCanvas.width / s
		const h = orientCanvas.height / s
		const r = w / 3
		const mtx = new Float64Array(6)
		matrixFill3d(mtx, rotX, rotY)

		const rc = mustBeNotNull(orientCanvas.getContext('2d'))
		rc.clearRect(0, 0, orientCanvas.width, orientCanvas.height)
		rc.save()
		rc.scale(s, s)
		rc.translate(w / 2, h / 2)

		rc.strokeStyle = '#555'
		rc.beginPath()
		rc.ellipse(0, 0, r / 2, (r / 2) * Math.abs(Math.sin(rotX)), 0, 0, Math.PI * 2, false)
		rc.stroke()

		const names = opts.rotationMode.split('-')
		drawOrientationAxis(rc, mtx, r, 0, 0, names[1], '#b90000')
		drawOrientationAxis(rc, mtx, 0, -r, 0, names[0], '#006700')
		drawOrientationAxis(rc, mtx, 0, 0, -r, names[2], '#0034ff')

		rc.restore()
	}

	let opts = initUI((newOpts, target) => {
		if (newOpts.rotationMode !== opts.rotationMode) {
			transition.fromMtx.set(mtx)
			matrixFill(mtx, rotX, rotY, newOpts.rotationMode)
			transition.startStamp = Date.now()
			let k = Math.min(1, matrixDistance(mtx, transition.fromMtx)) //0-1
			k = Math.pow(k, 0.5) //making short transitions a bit longer
			transition.endStamp = Date.now() + 1000 * k
		}

		opts = newOpts

		if (canvas.width !== opts.size || canvas.height !== opts.size)
			canvas.width = canvas.height = opts.size

		if (target === 'rot-x') rotX = opts.rotX
		if (target === 'rot-y') rotY = opts.rotY

		requestRedraw()
	})
	addEventListener('resize', () => resizeOrientation())
	resizeOrientation()
	canvas.width = canvas.height = opts.size
	requestRedraw()
})()
