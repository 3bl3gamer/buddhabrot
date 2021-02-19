import { controlDouble } from './control.js'
import { initUI, updateFPS, updateRotationInputs, updateStatus, updateZoomInput } from './ui.js'
import {
	mustBeInstanceOf,
	FPS,
	getById,
	mustBeNotNull,
	SubRenderer,
	matrixFill,
	matrixLerp,
	matrixFill3d,
	matrixDistance,
	Avg,
	drawOrientationAxis,
	drawEllipse,
	sleep,
	makeSimpleDeferredPromise,
} from './utils.js'

/**
 * Holds stuff that needs to be persistant between runRendering() calls
 */
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
		this.summBuf = new Uint32Array(0)
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
			if (value > 1.6) this._tryReduceAnimSubRenderers()
			// if difference is VERY large, reducing even more
			if (value > 1.75) this._tryReduceAnimSubRenderers()
			// if difference is small, increasing animation threads count
			if (value < 1.35) this._tryIncreaseAnimSubRenderers()
		}
	}
	/**
	 * @param {number} w
	 * @param {number} h
	 */
	resizeSummBuf(w, h) {
		if (this.summBuf.length !== w * h * 3) this.summBuf = new Uint32Array(w * h * 3)
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
 * @param {number} cOffset
 * @param {'inner'|'outer'} pointsMode
 * @param {'white_black'|'hue_atan_red'|'hue_atan_blue'|'hue_atan_green'|'hue_atan_asymm'|'hue_iters'|'rgb_layers'} colorMode
 * @param {(progress:number, startStamp:number, curThreads:number, maxThreads:number) => void} onStatusUpd
 */
async function runRendering(
	renderCore,
	abortSignal,
	wasm,
	canvas,
	mtx,
	iters,
	samples,
	cOffset,
	pointsMode,
	colorMode,
	onStatusUpd,
) {
	const rc = mustBeNotNull(canvas.getContext('2d'))
	const w = canvas.width
	const h = canvas.height

	renderCore.resizeSummBuf(w, h)

	let samplesRendered = 0
	let samplesRenderedAndRendering = 0
	let itersSamplesK = iters > 250 ? (250 / iters) ** 0.8 : (250 / iters) ** 0.5
	if (pointsMode === 'inner') itersSamplesK *= 0.25 //inner mode is slower
	const samplesChunkFast = Math.ceil(50 * 1000 * itersSamplesK)
	const samplesChunkSlow = Math.ceil(250 * 1000 * itersSamplesK)

	const renderStartStamp = Date.now()
	onStatusUpd(0, renderStartStamp, renderCore.animationSubRederers.length, renderCore.allSubRederers.length)

	// tracking which subRenderers have been restarted (srand + cleared summ buffer)
	const restartedSubRenderers = new Set()

	// Special delay, useful for last animation frame (when user has finished rotation
	// and smooth image is rendering with no interruptions via abortSignal).
	// Without this delay it'll take much longer for first preview to appear,
	// because this time rendering it not aborted and all workers are busy and
	// can not give back their pixels instantly.
	const firstRender = makeSimpleDeferredPromise()

	let isUpdatingImageData = false

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
		if (isAnimating && taskI === subRederers.length) await firstRender.promise

		if (abortSignal.aborted) break

		let freeSub =
			subRederers.find(x => !x.isWorkingOn('render')) ?? //fast search
			(await Promise.race(subRederers.map(x => x.wait('render').then(() => x)))) //slower search + wait

		if (abortSignal.aborted) break

		// if this subRenderer is used first time (during it's render), resetting it's random generator and clearing buffer
		const doClearRun = !restartedSubRenderers.has(freeSub)
		restartedSubRenderers.add(freeSub)

		const samplesChunk = Math.min(
			isAnimating ? samplesChunkFast : samplesChunkSlow,
			samples - samplesRenderedAndRendering,
		)
		samplesRenderedAndRendering += samplesChunk
		const promise = freeSub
			.render(w, h, doClearRun, iters, samplesChunk, cOffset, pointsMode, colorMode, mtx)
			.then(async () => {
				tasksRendered++
				tasksNotYetOnCanvas++
				samplesRendered += samplesChunk

				// should not update image before each render thread has rendered at least once (to avoid flickering)
				if (tasksRendered >= subRederers.length && !isUpdatingImageData) {
					let curRedrawInterval = redrawInterval
					// if updateImageData() takes too long, further reducing redraw interval and saving even more precious [milli]seconds
					curRedrawInterval = Math.max(curRedrawInterval, imageDataUpdateTime * 1.2)
					// reducing first redraws interval to make transition between noisy->smooth more... smooth
					curRedrawInterval *= Math.min(1, tasksRendered / subRederers.length / 20)
					if (
						Date.now() - lastRedrawAt > curRedrawInterval ||
						tasksRendered === subRederers.length
					) {
						isUpdatingImageData = true
						const subs = Array.from(restartedSubRenderers)
						imageDataUpdateTime = await updateImageData(renderCore, wasm, w, h, rc, subs, false)
						lastRedrawAt = Date.now()
						tasksNotYetOnCanvas = 0
						isUpdatingImageData = false
						firstRender.resolve()
					}
				}

				if (tasksRendered > subRederers.length) {
					onStatusUpd(
						samplesRendered / samples,
						renderStartStamp,
						subRederers.length,
						renderCore.allSubRederers.length,
					)
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
	if (tasksNotYetOnCanvas > 0)
		await updateImageData(renderCore, wasm, w, h, rc, Array.from(restartedSubRenderers), true)
	console.timeEnd('full render')
}

/**
 * @param {RenderCore} renderCore
 * @param {WasmCore} wasm
 * @param {number} w
 * @param {number} h
 * @param {CanvasRenderingContext2D} rc
 * @param {SubRenderer[]} subRenderers
 * @param {boolean} sync
 */
async function updateImageData(renderCore, wasm, w, h, rc, subRenderers, sync) {
	console.time('updateImageData')
	const stt = Date.now()

	let clear = true
	while (true) {
		// trying free subRenderers at first
		const freeSubI = subRenderers.findIndex(x => !x.isWorkingOn('render'))
		const subRenderer = freeSubI === -1 ? subRenderers.pop() : subRenderers.splice(freeSubI, 1)[0]
		if (!subRenderer) break

		renderCore.summBuf = await subRenderer.addBufTo(renderCore.summBuf, clear)
		clear = false
	}

	const pixBuf = await wasm.fillImageData(w, h, renderCore.summBuf, renderCore.contrast, sync)
	const imgData = new ImageData(pixBuf, w, h)
	rc.putImageData(imgData, 0, 0)

	console.timeEnd('updateImageData')
	return Date.now() - stt
}

/**
 * @typedef {Object} WasmCore
 * @prop {(w:number, h:number, buf:Uint32Array, contrast:number, sync:boolean) => Promise<Uint8ClampedArray>} WasmCore.fillImageData
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
	const WA_prepare_color_conversion = /** @type {(w:number, h:number, step:number, contrast:number) => void} */ (exports.prepare_color_conversion)
	const WA_convert_colors_for_image_data = /** @type {(w:number, h:number, fromLine:number, linesCount:number) => void} */ (exports.convert_colors_for_image_data)
	const WA_get_in_buf_ptr = /** @type {() => number} */ (exports.get_in_buf_ptr)
	const WA_get_out_buf_ptr = /** @type {(w:number, h:number) => number} */ (exports.get_out_buf_ptr)

	function ensureMemSize(w, h) {
		const delta = WA_get_required_memory_size(w, h) - WA_memory.buffer.byteLength
		const deltaPages = Math.ceil(delta / 65536)
		if (deltaPages > 0) WA_memory.grow(deltaPages)
	}

	return /** @type {WasmCore} */ ({
		async fillImageData(w, h, summBuf, contrast, sync) {
			ensureMemSize(w, h)

			const inBuf = new Uint32Array(WA_memory.buffer, WA_get_in_buf_ptr(), w * h * 3)
			inBuf.set(summBuf)

			const colorNormStep = w <= 256 ? 1 : w <= 512 ? 2 : w <= 1024 ? 3 : 4
			WA_prepare_color_conversion(w, h, colorNormStep, contrast)
			if (!sync && w > 1024) await sleep(1)

			const lineStep = Math.ceil((512 * 512) / w)
			for (let lineFrom = 0; lineFrom < h; lineFrom += lineStep) {
				WA_convert_colors_for_image_data(w, h, lineFrom, Math.min(lineStep, h - lineFrom))
				if (!sync && lineFrom + lineStep < h) await sleep(1)
			}

			const WA_pix = new Uint8ClampedArray(WA_memory.buffer, WA_get_out_buf_ptr(w, h), w * h * 4)
			return WA_pix
		},
	})
}

;(async () => {
	const canvas = getById('main-canvas', HTMLCanvasElement)
	const orientCanvas = getById('orientation-canvas', HTMLCanvasElement)
	const renderCore = new RenderCore()

	const fps = new FPS(updateFPS)

	const mtx = new Float64Array(8)
	const transition = { fromMtx: new Float64Array(8), startStamp: 0, endStamp: 0 }
	let rotX = 0
	let rotY = 0
	let prevX = null
	let prevY = null
	let prevTouchDis = null
	let zoom = 1

	const wasm = await initWasm()

	function move(x, y) {
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
	}
	function scale(delta) {
		zoom *= delta
		updateZoomInput(zoom)
		requestRedraw()
	}
	controlDouble({
		startElem: canvas,
		callbacks: {
			singleDown(e, id, x, y, isSwitching) {
				prevX = x
				prevY = y
				return true
			},
			singleMove(e, id, x, y) {
				move(x, y)
				return true
			},
			singleUp(e, id, isSwitching) {
				prevX = prevY = null
				return true
			},
			doubleDown(e, id0, x0, y0, id1, x1, y1, isSwitching) {
				prevX = (x0 + x1) / 2
				prevY = (y0 + y1) / 2
				prevTouchDis = Math.sqrt((x1 - x0) ** 2 + (y1 - y0) ** 2)
				return true
			},
			doubleMove(e, id0, x0, y0, id1, x1, y1) {
				const x = (x0 + x1) / 2
				const y = (y0 + y1) / 2
				move(x, y)
				const dis = Math.sqrt((x1 - x0) ** 2 + (y1 - y0) ** 2)
				scale(dis / prevTouchDis)
				prevTouchDis = dis
				return true
			},
			doubleUp(e, id0, id1, isSwitching) {
				prevX = prevY = prevTouchDis = null
				return true
			},
			wheelRot(e, dx, dy, dz, x, y) {
				scale(Math.pow(2, -dy / 1000))
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
			.finally(() => {
				redrawRequested--
			})
	}
	/**
	 * @param {AbortSignal} abortSignal
	 */
	async function redraw(abortSignal) {
		matrixFill(mtx, rotX, rotY, zoom, opts.rotationMode)
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
			opts.cOffset,
			opts.pointsMode,
			opts.colorMode,
			updateStatus,
		)
		if (abortSignal.aborted) fps.frame()
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
		if (newOpts.rotationMode !== opts.rotationMode || target === 'all') {
			transition.fromMtx.set(mtx)
			matrixFill(mtx, rotX, rotY, newOpts.zoom, newOpts.rotationMode)
			transition.startStamp = Date.now()
			let k = Math.min(1, matrixDistance(mtx, transition.fromMtx)) //0-1
			k = Math.pow(k, 0.5) //making short transitions a bit longer
			transition.endStamp = Date.now() + 1000 * k
		}

		opts = newOpts

		if (canvas.width !== opts.size || canvas.height !== opts.size)
			canvas.width = canvas.height = opts.size

		rotX = opts.rotX
		rotY = opts.rotY
		zoom = opts.zoom
		renderCore.contrast = opts.contrast

		if (target === 'contrast') {
			const rc = mustBeNotNull(canvas.getContext('2d'))
			updateImageData(renderCore, wasm, canvas.width, canvas.height, rc, [], true) //TODO:concurrency
		}
		if (target !== 'contrast') requestRedraw()
		redrawOrientation()
	})
	canvas.width = canvas.height = opts.size
	rotX = opts.rotX
	rotY = opts.rotY
	zoom = opts.zoom
	renderCore.contrast = opts.contrast

	addEventListener('resize', () => resizeOrientation())
	resizeOrientation()
	requestRedraw()
})()
