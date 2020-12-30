import { controlDouble } from './control.js'
import { getById, mustBeNotNull, sleep, SubRenderer } from './utils.js'

/**
 * @param {SubRenderer[]} subRederers
 * @param {AbortSignal} abortSignal
 * @param {HTMLCanvasElement} canvas
 * @param {ImageData} imgData
 * @param {Uint32Array} buf
 * @param {number} x
 * @param {number} y
 */
async function runRendering(subRederers, abortSignal, canvas, imgData, buf, x, y, mtx) {
	const rc = mustBeNotNull(canvas.getContext('2d'))
	const w = imgData.width
	const h = imgData.height

	const iters = 250
	const samples = 250 * 1000

	console.time('full render')
	let lastRedrawAt = Date.now()
	const promises = []
	for (let sample = 0; sample < 64; sample++) {
		if (sample >= 4 && abortSignal.aborted) break
		let freeSub = await Promise.race(subRederers.map(x => x.wait().then(() => x)))
		// while (freeSub.isWorking()) freeSub = await Promise.race(subRederers.map(x => x.wait().then(() => x)))
		const seed = freeSub.id * 1000 + sample
		const promise = freeSub.render(w, h, seed, iters, samples, mtx).then(() => {
			freeSub.addBufTo(buf)
			// updateImageDataThrottled()
			if (Date.now() - lastRedrawAt > 500) {
				updateImageData(rc, imgData, buf, x, y, w, h)
				lastRedrawAt = Date.now()
			}
			promises.splice(promises.indexOf(promise), 1)
		})
		promises.push(promise)
	}
	await Promise.all(promises)
	updateImageData(rc, imgData, buf, x, y, w, h)
	console.timeEnd('full render')
}

/**
 * @param {CanvasRenderingContext2D} rc
 * @param {ImageData} imgData
 * @param {Uint32Array} buf
 * @param {number} x
 * @param {number} y
 * @param {number} w
 * @param {number} h
 */
function updateImageData(rc, imgData, buf, x, y, w, h) {
	let sum = 0
	for (let i = 0; i < w - 1; i += 2)
		for (let j = 0; j < h - 1; j += 2) {
			sum += lum(buf, (i + j * w) * 3)
		}
	const avgLum = sum / ((w * h) / 4)

	const histo = new Uint32Array(256)
	for (let i = 0; i < w; i++)
		for (let j = 0; j < h; j++) {
			const l = lum(buf, (i + j * w) * 3)
			let index = Math.floor((l / avgLum) * histo.length * 0.025)
			if (index >= histo.length) index = histo.length - 1
			histo[index]++
		}

	let brightnessK = 1
	let drain = 0.0001 * w * h
	for (let i = histo.length - 1; i >= 0; i--) {
		const val = histo[i]
		if (val <= drain) {
			drain -= val
		} else {
			// console.log(i, val, drain)
			const histoPos = (i + 1 - drain / val) / histo.length
			const threshLum = (histoPos * avgLum) / 0.025
			brightnessK = 1 / threshLum
			break
		}
	}
	// brightnessK
	// console.log(histo, avgLum)

	const pix = imgData.data
	pix.fill(0)
	for (let i = 0; i < w; i++) {
		for (let j = 0; j < h; j++) {
			const posPix = (i + j * w) * 4
			const posBuf = (i + j * w) * 3
			pix[posPix + 0] = Math.pow(buf[posBuf + 0] * brightnessK, 0.85) * 255
			pix[posPix + 1] = Math.pow(buf[posBuf + 1] * brightnessK, 0.85) * 255
			pix[posPix + 2] = Math.pow(buf[posBuf + 2] * brightnessK, 0.85) * 255
			pix[posPix + 3] = 255
		}
	}
	rc.putImageData(imgData, x, y)
}
function lum(buf, pos) {
	const r = buf[pos + 0]
	const g = buf[pos + 1]
	const b = buf[pos + 2]
	return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

;(async () => {
	const canvas = getById('canvas', HTMLCanvasElement)
	const imgData = new ImageData(canvas.width, canvas.height)
	const buf = new Uint32Array(canvas.width * canvas.height * 3)
	const subRederers = Array(navigator.hardwareConcurrency)
		.fill(0)
		.map((_, i) => new SubRenderer(i))

	const mtx = new Float64Array(8)
	let rotY = 0
	let prevX = null

	controlDouble({
		startElem: canvas,
		callbacks: {
			singleDown(e, id, x, y, isSwitching) {
				prevX = x
				return true
			},
			singleMove(e, id, x, y) {
				rotY -= (x - prevX) * 0.01
				prevX = x
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
			.finally(() => {
				redrawRequested--
			})
	}
	/**
	 * @param {AbortSignal} abortSignal
	 */
	async function redraw(abortSignal) {
		mtx[0] = 0 //a
		mtx[1] = Math.cos(rotY) //b
		mtx[2] = Math.sin(rotY) //cx
		mtx[4] = 1 //a
		mtx[5] = 0 //b
		mtx[6] = 0 //cx
		buf.fill(0)
		await runRendering(subRederers, abortSignal, canvas, imgData, buf, 0, 0, mtx)
	}

	requestRedraw()
})()
