import { controlDouble } from './control.js'
import { mustBeInstanceOf, FPS, getById, mustBeNotNull, SubRenderer } from './utils.js'

/**
 * @param {SubRenderer[]} subRederers
 * @param {AbortSignal} abortSignal
 * @param {WasmCore} wasm
 * @param {HTMLCanvasElement} canvas
 * @param {number} x
 * @param {number} y
 * @param {number} w
 * @param {number} h
 * @param {Float64Array} mtx
 */
async function runRendering(subRederers, abortSignal, wasm, canvas, x, y, w, h, mtx) {
	const rc = mustBeNotNull(canvas.getContext('2d'))

	const buf = wasm.getInBufView(w, h)
	wasm.clearInBuf(w, h) //works a bit faster than buf.fill(0) in FF

	const coreIters = 250
	const coreSamplesFast = 50 * 1000
	const coreSamplesSlow = 250 * 1000

	console.time('full render')
	console.time('actual render')
	const minRedrawInterval = 500
	let lastRedrawAt = Date.now()
	let samplesDrawn = 0
	const promises = []
	for (let sample = 0; sample < 128; sample++) {
		const isAnimating = sample < subRederers.length * 2

		if (abortSignal.aborted) break

		let freeSub =
			subRederers.find(x => !x.isWorking()) ?? //fast search
			(await Promise.race(subRederers.map(x => x.wait().then(() => x)))) //slower search + wait

		if (abortSignal.aborted) break

		const coreSamples = isAnimating ? coreSamplesFast : coreSamplesSlow
		const seed = freeSub.id * 1000 + sample
		const promise = freeSub.render(w, h, seed, coreIters, coreSamples, mtx).then(() => {
			freeSub.addBufTo(buf)
			samplesDrawn++
			if (Date.now() - lastRedrawAt > minRedrawInterval) {
				wasm.updateImageData(rc, x, y, w, h)
				lastRedrawAt = Date.now()
			}
			promises.splice(promises.indexOf(promise), 1)
		})
		promises.push(promise)
	}
	await Promise.all(promises)

	console.timeEnd('actual render')
	wasm.updateImageData(rc, x, y, w, h)
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
	const WA_prepare_image_data = /** @type {(w:number, h:number) => void} */ (exports.prepare_image_data)
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
			WA_prepare_image_data(w, h)
			const WA_pix = new Uint8ClampedArray(WA_memory.buffer, WA_get_out_buf_ptr(w, h), w * h * 4)
			const imgData = new ImageData(WA_pix, w, h)
			rc.putImageData(imgData, x, y)
		},
	})
}

;(async () => {
	const canvas = getById('canvas', HTMLCanvasElement)
	const subRederers = Array(navigator.hardwareConcurrency)
		.fill(0)
		.map((_, i) => new SubRenderer(i))

	const fpsBox = getById('fpsBox', HTMLDivElement)
	const fps = new FPS(fps => (fpsBox.textContent = fps.toFixed(1)))

	const mtx = new Float64Array(8)
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
				prevX = x
				prevY = y
				requestRedraw()
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
		//  cosY       0     sinY
		//  sinX*sinY  cosX -sinX*cosY
		// -cosX*sinY  sinX  cosX*cosY
		mtx[1] = Math.cos(rotY) //b
		mtx[0] = 0 //a
		mtx[2] = Math.sin(rotY) //cx
		// mtx[3] = Math.sin(rotY) //cy
		mtx[5] = Math.sin(rotX) * Math.sin(rotY) //b
		mtx[4] = Math.cos(rotX) //a
		mtx[6] = -Math.sin(rotX) * Math.cos(rotY) //cx
		// mtx[7] = 0 //cy
		const w = canvas.width
		const h = canvas.height
		await runRendering(subRederers, abortSignal, wasm, canvas, 0, 0, w, h, mtx)
	}

	requestRedraw()
})()
