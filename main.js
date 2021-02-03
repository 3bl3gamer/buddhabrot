import { controlDouble } from './control.js'
import { FPS, getById, mustBeNotNull, SubRenderer } from './utils.js'

/**
 * @param {SubRenderer[]} subRederers
 * @param {AbortSignal} abortSignal
 * @param {HTMLCanvasElement} canvas
 * @param {ImageData} imgData
 * @param {Uint32Array} buf
 * @param {number} x
 * @param {number} y
 * @param {Float64Array} mtx
 */
async function runRendering(subRederers, abortSignal, canvas, imgData, buf, x, y, mtx) {
	const rc = mustBeNotNull(canvas.getContext('2d'))
	const w = imgData.width
	const h = imgData.height

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
				updateImageData(rc, imgData, buf, x, y, w, h, true)
				lastRedrawAt = Date.now()
			}
			promises.splice(promises.indexOf(promise), 1)
		})
		promises.push(promise)
	}
	await Promise.all(promises)

	console.timeEnd('actual render')
	updateImageData(rc, imgData, buf, x, y, w, h, true)
	console.timeEnd('full render')
}

let lastBrightnessK = /** @type {number|null} */ (null)
/**
 * @param {CanvasRenderingContext2D} rc
 * @param {ImageData} imgData
 * @param {Uint32Array} buf
 * @param {number} x
 * @param {number} y
 * @param {number} w
 * @param {number} h
 * @param {boolean} updateBrightness
 */
function updateImageData(rc, imgData, buf, x, y, w, h, updateBrightness) {
	console.log('uidata')
	let brightnessK = 1
	if (updateBrightness || lastBrightnessK === null) {
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
		lastBrightnessK = brightnessK
	} else {
		brightnessK = lastBrightnessK
	}

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
	return brightnessK
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

	const fpsBox = getById('fpsBox', HTMLDivElement)
	const fps = new FPS(fps => (fpsBox.textContent = fps.toFixed(1)))

	const mtx = new Float64Array(8)
	let rotX = 0
	let rotY = 0
	let prevX = null
	let prevY = null

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
		buf.fill(0)
		await runRendering(subRederers, abortSignal, canvas, imgData, buf, 0, 0, mtx)
	}

	requestRedraw()
})()
