import { controlDouble } from './control.js'
import { initUI, updateRotationInputs, updateStatus } from './ui.js'
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
	drawOrientationAxis,
	drawEllipse,
} from './utils.js'

// TODO:
// https://www.youtube.com/watch?v=ovJcsL7vyrk
// color modes
// adjust samplesChunkFast by device speed
// zoom

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
		this.contrast = 1
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
	}
}

/**
 * @param {RenderCore} renderCore
 * @param {AbortSignal} abortSignal
 * @param {WasmCore} wasm
 * @param {HTMLCanvasElement} canvas
 * @param {Float64Array} mtx
 * @param {number} iters
 * @param {number} samples
 * @param {'inner'|'outer'} pointsMode
 * @param {(progress:number, curThreads:number, maxThreads:number) => void} onStatusUpd
 */
async function runRendering(
	renderCore,
	abortSignal,
	wasm,
	canvas,
	mtx,
	iters,
	samples,
	pointsMode,
	onStatusUpd,
) {
	const rc = mustBeNotNull(canvas.getContext('2d'))
	const w = canvas.width
	const h = canvas.height

	const buf = wasm.getInBufView(w, h)
	wasm.clearInBuf(w, h) //works a bit faster than buf.fill(0) in FF

	let samplesRendered = 0
	let samplesRenderedAndRendering = 0
	let itersSamplesK = iters > 250 ? (250 / iters) ** 0.8 : (250 / iters) ** 0.5
	if (pointsMode === 'inner') itersSamplesK *= 0.25 //inner mode is slower
	const samplesChunkFast = Math.ceil(50 * 1000 * itersSamplesK)
	const samplesChunkSlow = Math.ceil(50 * 1000 * itersSamplesK) //UPD: seems ~ok to keem them same

	onStatusUpd(0, renderCore.animationSubRederers.length, renderCore.allSubRederers.length)

	console.time('full render')
	console.time('actual render')
	const redrawInterval = 500
	let lastRedrawAt = Date.now()
	let tasksRendered = 0
	let tasksNotYetOnCanvas = 0
	let imageDataUpdateTime = 0
	const promises = []
	for (let taskI = 0; samplesRenderedAndRendering < samples; taskI++) {
		let isAnimating = taskI < renderCore.animationSubRederers.length * 2
		if (imageDataUpdateTime > 500) isAnimating = false //it is no longer animation, it is slideshow (not even trying to make smth smooth now)
		const subRederers = isAnimating ? renderCore.animationSubRederers : renderCore.allSubRederers

		if (abortSignal.aborted) break

		let freeSub =
			subRederers.find(x => !x.isWorking()) ?? //fast search
			(await Promise.race(subRederers.map(x => x.wait().then(() => x)))) //slower search + wait

		if (abortSignal.aborted) break

		const samplesChunk = Math.min(
			isAnimating ? samplesChunkFast : samplesChunkSlow,
			samples - samplesRenderedAndRendering,
		)
		samplesRenderedAndRendering += samplesChunk
		const seed = freeSub.id * 1000 + taskI
		const promise = freeSub.render(w, h, seed, iters, samplesChunk, pointsMode, mtx).then(() => {
			freeSub.addBufTo(buf)
			tasksRendered++
			tasksNotYetOnCanvas++
			samplesRendered += samplesChunk
			// should not update image before each render thread has rendered at least once (to avoid flickering)
			if (tasksRendered >= subRederers.length) {
				// reducing first redraws interval to make transition between noisy->smooth more... smooth
				let curRedrawInterval = redrawInterval * Math.min(1, tasksRendered / subRederers.length / 20)
				// if updateImageData() takes 1s (for example), should not call more than once a second, otherwise renderers will stay idle too long
				curRedrawInterval = Math.max(curRedrawInterval, imageDataUpdateTime * 1.2)
				if (Date.now() - lastRedrawAt > curRedrawInterval || tasksRendered === subRederers.length) {
					imageDataUpdateTime = wasm.updateImageData(rc, w, h, renderCore.contrast)
					lastRedrawAt = Date.now()
					tasksNotYetOnCanvas = 0
				}
			}
			if (tasksRendered > subRederers.length) {
				onStatusUpd(samplesRendered / samples, subRederers.length, renderCore.allSubRederers.length)
			}
			promises.splice(promises.indexOf(promise), 1)
		})
		promises.push(promise)
	}
	await Promise.all(promises)

	// if each thread had rendered once and then rerender request has come
	if (tasksRendered === renderCore.animationSubRederers.length) {
		renderCore.adjustAnimSubRenderersCount()
	}

	console.timeEnd('actual render')
	if (tasksNotYetOnCanvas > 0) wasm.updateImageData(rc, w, h, renderCore.contrast)
	console.timeEnd('full render')
}

/**
 * @typedef {Object} WasmCore
 * @prop {(w:number, h:number) => Uint32Array} WasmCore.getInBufView
 * @prop {(w:number, h:number) => void} clearInBuf
 * @prop {(rc:CanvasRenderingContext2D, w:number, h:number, contrast:number) => number} WasmCore.updateImageData
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
	const WA_prepare_image_data = /** @type {(w:number, h:number, step:number, contrast:number) => void} */ (exports.prepare_image_data)
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
		updateImageData(rc, w, h, contrast) {
			const stt = Date.now()
			console.time('updateImageData')
			ensureMemSize(w, h)
			const step = w <= 256 ? 1 : w <= 512 ? 2 : w <= 1024 ? 3 : 4
			WA_prepare_image_data(w, h, step, contrast)
			const WA_pix = new Uint8ClampedArray(WA_memory.buffer, WA_get_out_buf_ptr(w, h), w * h * 4)
			const imgData = new ImageData(WA_pix, w, h)
			rc.putImageData(imgData, 0, 0)
			console.timeEnd('updateImageData')
			return Date.now() - stt
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
				redrawOrientation()
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
		// redrawOrientation()
		await runRendering(
			renderCore,
			abortSignal,
			wasm,
			canvas,
			mtx,
			opts.iters,
			opts.samples,
			opts.pointsMode,
			updateStatus,
		)
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
	function redrawOrientation() {
		const s = devicePixelRatio
		const w = orientCanvas.width / s
		const h = orientCanvas.height / s
		const r = w / 3
		const cr = r / 2
		const mtx = new Float64Array(6)
		matrixFill3d(mtx, rotX, rotY)

		const rc = mustBeNotNull(orientCanvas.getContext('2d'))
		rc.clearRect(0, 0, orientCanvas.width, orientCanvas.height)
		rc.save()
		rc.scale(s, s)
		rc.translate(w / 2, h / 2)

		if (rotX >= 0) drawEllipse(rc, cr, cr * Math.sin(rotX), 'rgba(64,64,64,0.5)', '#555')

		const names = opts.rotationMode.split('-')
		const redBlueOrder = Math.sin(rotY - (Math.PI * 1) / 4)
		if (redBlueOrder < 0) {
			drawOrientationAxis(rc, mtx, r, 0, 0, names[1], '#b90000')
			drawOrientationAxis(rc, mtx, 0, -r, 0, names[0], '#006700')
			drawOrientationAxis(rc, mtx, 0, 0, -r, names[2], '#0034ff')
		} else {
			drawOrientationAxis(rc, mtx, 0, 0, -r, names[2], '#0034ff')
			drawOrientationAxis(rc, mtx, 0, -r, 0, names[0], '#006700')
			drawOrientationAxis(rc, mtx, r, 0, 0, names[1], '#b90000')
		}

		if (rotX < 0) drawEllipse(rc, cr, cr * Math.sin(rotX), 'rgba(16,16,16,0.5)', '#555')

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
		renderCore.contrast = opts.contrast

		if (target === 'contrast') {
			const rc = mustBeNotNull(canvas.getContext('2d'))
			wasm.updateImageData(rc, canvas.width, canvas.height, renderCore.contrast)
		}
		if (target !== 'contrast') requestRedraw()
		redrawOrientation()
	})
	addEventListener('resize', () => resizeOrientation())
	resizeOrientation()
	canvas.width = canvas.height = opts.size
	requestRedraw()
})()
