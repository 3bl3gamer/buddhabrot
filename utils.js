export class SubRenderer {
	/**
	 * @param {number} id
	 */
	constructor(id) {
		this.id = id
		this.worker = new Worker('worker.js')
		this.worker.onmessage = this._onWorkerMessage.bind(this)
		this.buf = new Uint32Array(0)
		this._job = /** @type {null | {onRendered: () => void, promise:Promise<void>}} */ (null)
		this._renderStartStamp = 0
		this.lastRenderDuration = 0
	}
	/** @param {MessageEvent<any>} e */
	_onWorkerMessage(e) {
		if (e.data.cmd === 'rendered') {
			if (!this._job) throw new Error('is not rendering')
			this.buf = e.data.buf
			const onRendered = this._job.onRendered
			this._job = null
			this.lastRenderDuration = Date.now() - this._renderStartStamp
			onRendered()
		}
	}
	_resize(w, h) {
		if (w * h * 3 !== this.buf.length) this.buf = new Uint32Array(w * h * 3)
	}
	render(w, h, seed, ...args) {
		if (this._job) throw new Error('already rendering')
		let resolve = /** @type {null | (() => void)} */ (null)
		const promise = new Promise((resolve_, reject) => {
			this._resize(w, h)
			this.worker.postMessage({ cmd: 'render', buf: this.buf, w, h, seed, args }, [this.buf.buffer])
			resolve = /** @type {() => void} */ (resolve_)
		})
		this._job = { onRendered: mustBeNotNull(resolve), promise }
		this._renderStartStamp = Date.now()
		return promise
	}
	wait() {
		return this._job ? this._job.promise : Promise.resolve()
	}
	isWorking() {
		return !!this._job
	}
	/*hardReset() {
		this.worker.terminate()
		this.worker = new Worker('worker.js')
		this.worker.onmessage = this._onWorkerMessage.bind(this)
		if (this._job) this._job.onRendered()
		this._job = null
		this.buf.fill(0)
	}*/
	addBufTo(buf) {
		for (let i = 0; i < this.buf.length; i++) {
			buf[i] += this.buf[i]
		}
	}
}

export class FPS {
	constructor(/**@type {(fps:number) => unknown}*/ onUpdate) {
		this._lastUpdStamp = Date.now()
		this._framesCount = 0
		this._onUpdate = onUpdate
		this.value = 0
	}
	frame() {
		this._framesCount++
		const now = Date.now()
		const delta = now - this._lastUpdStamp
		if (delta >= 1000) {
			this.value = (this._framesCount / delta) * 1000
			this._lastUpdStamp = now
			this._framesCount = 0
			this._onUpdate(this.value)
		}
	}
}

export class Avg {
	/** @param {number} capacity */
	constructor(capacity) {
		this.capacity = capacity
		this.values = []
	}
	/** @param {number} value */
	add(value) {
		if (this.values.length < this.capacity) {
			this.values.push(value)
		} else {
			for (let i = 0; i < this.values.length - 1; i++) {
				this.values[i] = this.values[i + 1]
			}
			this.values[this.values.length - 1] = value
		}
	}
	value() {
		let sum = 0
		for (let i = 0; i < this.values.length; i++) sum += this.values[i]
		return sum / this.values.length
	}
	/** @param {number} n */
	hasAtLeast(n) {
		return this.values.length >= n
	}
	clear() {
		this.values.length = 0
	}
}

/**
 * @template T
 * @param {T|null} val
 * @returns {T}
 */
export function mustBeNotNull(val) {
	if (val === null) throw new Error('value must not be null')
	return val
}

/**
 * @template {{ new (...args: any): any }[]} T
 * @param {unknown} obj
 * @param  {T} classes
 * @returns {InstanceType<T[number]>}
 */
export function mustBeInstanceOf(obj, ...classes) {
	for (const class_ of classes) {
		if (obj instanceof class_) return obj
	}
	throw new Error(`object must be ${classes.map(x => x.name).join('|')}, got ${obj}`)
}

/**
 * @template {{ new (...args: any): any }} T
 * @param {string} id
 * @param {T} class_
 * @returns {InstanceType<T>}
 */
export function getById(id, class_) {
	const el = document.getElementById(id)
	if (el === null) throw new Error('no element with id ' + id)
	return mustBeInstanceOf(el, class_)
}

/**
 * @param {number} mills
 */
export function sleep(mills) {
	return new Promise(resolve => setTimeout(resolve, mills))
}

/**
 * @template {unknown[]} TArgs
 * @param {(...args:TArgs) => void} func
 * @param {number} interval
 * @returns {(...args:TArgs) => void}
 */
export function throttle(func, interval) {
	let lastCallAt = 0
	let timeout = /** @type {number|null} */ (null)
	let lastArgs = /** @type {TArgs|null} */ (null)
	return (...args) => {
		lastArgs = args
		const now = Date.now()
		const elapsed = now - lastCallAt

		if (elapsed >= interval) {
			lastCallAt = now
			func(...lastArgs)
		} else {
			if (timeout === null) {
				timeout = setTimeout(() => {
					lastCallAt = Date.now()
					timeout = null
					func(.../**@type {TArgs}*/ (lastArgs))
				}, interval - elapsed)
			}
		}
	}
}

/**
 * @param {Float64Array} mtx
 * @param {number} rotX
 * @param {number} rotY
 * @param {number} zoom
 * @param {import('./ui.js').Opts['rotationMode']} rotationMode
 */
export function matrixFill(mtx, rotX, rotY, zoom, rotationMode) {
	//  cosY       0     sinY
	//  sinX*sinY  cosX -sinX*cosY
	// -cosX*sinY  sinX  cosX*cosY //ignored
	const a11 = Math.cos(rotY)
	const a12 = 0
	const a13 = Math.sin(rotY)
	const a21 = Math.sin(rotX) * Math.sin(rotY)
	const a22 = Math.cos(rotX)
	const a23 = -Math.sin(rotX) * Math.cos(rotY)
	let idx = []
	switch (rotationMode) {
		case 'a-b-cx':
			idx = [0, 1, 2]
			break
		case 'a-b-cy':
			idx = [0, 1, 3]
			break
		case 'cx-cy-a':
			idx = [2, 3, 0]
			break
		case 'cx-cy-b':
			idx = [2, 3, 1]
			break
	}
	mtx.fill(0)
	// 0,1 and 3,4 are swapped, so whole image is rotated 90deg clockwise and "peak" is pointing upwards
	mtx[idx[1]] = a11 * zoom
	mtx[idx[0]] = a12 * zoom
	mtx[idx[2]] = a13 * zoom
	mtx[idx[1] + 4] = a21 * zoom
	mtx[idx[0] + 4] = a22 * zoom
	mtx[idx[2] + 4] = a23 * zoom
}

/**
 * @param {Float64Array} mtx
 * @param {number} rotX
 * @param {number} rotY
 */
export function matrixFill3d(mtx, rotX, rotY) {
	mtx[0] = Math.cos(rotY)
	mtx[1] = 0
	mtx[2] = Math.sin(rotY)
	mtx[3] = Math.sin(rotX) * Math.sin(rotY)
	mtx[4] = Math.cos(rotX)
	mtx[5] = -Math.sin(rotX) * Math.cos(rotY)
}

/**
 * @param {Float64Array} mtx
 * @param {number} x
 * @param {number} y
 * @param {number} z
 * @returns {[number, number]}
 */
export function matrixApply3d(mtx, x, y, z) {
	return [
		mtx[0] * x + mtx[1] * y + mtx[2] * z, //
		mtx[3] * x + mtx[4] * y + mtx[5] * z,
	]
}

/**
 * @param {Float64Array} out
 * @param {Float64Array} a
 * @param {Float64Array} b
 * @param {number} k
 */
export function matrixLerp(out, a, b, k) {
	const kInv = 1 - k
	for (let i = 0; i < out.length; i++) out[i] = a[i] * kInv + b[i] * k
}

/**
 * @param {Float64Array} a
 * @param {Float64Array} b
 */
export function matrixDistance(a, b) {
	let sum = 0
	for (let i = 0; i < a.length; i++) sum += (a[i] - b[i]) ** 2
	return Math.sqrt(sum)
}

/**
 * @param {CanvasRenderingContext2D} rc
 * @param {Float64Array} mtx
 * @param {number} dx
 * @param {number} dy
 * @param {number} dz
 * @param {string} label
 * @param {string} color
 */
export function drawOrientationAxis(rc, mtx, dx, dy, dz, label, color) {
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

/**
 * @param {CanvasRenderingContext2D} rc
 * @param {number} xr
 * @param {number} yr
 * @param {string|null} fillStyle
 * @param {string} strokeStyle
 */
export function drawEllipse(rc, xr, yr, fillStyle, strokeStyle) {
	rc.beginPath()
	rc.ellipse(0, 0, Math.abs(xr), Math.abs(yr), 0, 0, Math.PI * 2, false)
	if (fillStyle !== null) {
		rc.fillStyle = fillStyle
		rc.fill()
	}
	rc.strokeStyle = strokeStyle
	rc.stroke()
}
