/** @typedef {import('./worker.js').RequestMsg['cmd']} JobKind */

export class SubRenderer {
	/**
	 * @param {number} id
	 */
	constructor(id) {
		this.id = id
		this.worker = new Worker('worker.js')
		this.worker.onmessage = this._onWorkerMessage.bind(this)
		this._jobs = /**@type {Record<JobKind, {onFinished(...args:any):void, promise:Promise<any>}>}*/ ({})
		this._renderStartStamp = 0
		this.lastRenderDuration = 0
	}
	/** @param {MessageEvent<any>} e */
	_onWorkerMessage(e) {
		const data = /**@type {import('./worker.js').ResponseMsg}*/ (e.data)

		if (data.cmd === 'rendered') {
			const job = this._jobs['render']
			if (!job) throw new Error('is not rendering')
			// @ts-ignore
			delete this._jobs['render']
			this.lastRenderDuration = Date.now() - this._renderStartStamp
			job.onFinished()
		} else if (data.cmd === 'added') {
			const job = this._jobs['add']
			if (!job) throw new Error('is not adding')
			// @ts-ignore
			delete this._jobs['add']
			job.onFinished(data.buf)
		}
	}
	/**
	 * @param {import('./worker.js').RequestMsg} params
	 * @param {Transferable[]} transfer
	 */
	_sendWorkerTask(params, transfer) {
		if (this._jobs[params.cmd]) throw new Error(`already running ${params.cmd}`)
		this.worker.postMessage(params, transfer)
		const { resolve, promise } = makeSimpleDeferredPromise()
		this._jobs[params.cmd] = { onFinished: mustBeNotNull(resolve), promise }
		this._renderStartStamp = Date.now()
		return promise
	}
	/**
	 * @param {number} w
	 * @param {number} h
	 * @param {boolean} doReset
	 * @param  {import('./worker.js').RenderArgsArr} args
	 * @returns {Promise<void>}
	 */
	render(w, h, doReset, ...args) {
		const reset = doReset ? { seed: this.id } : null
		return this._sendWorkerTask({ cmd: 'render', w, h, reset, args }, [])
	}
	/**
	 * @param {Uint32Array} buf
	 * @param {boolean} clear
	 * @returns {Promise<Uint32Array>}
	 */
	addBufTo(buf, clear) {
		return this._sendWorkerTask({ cmd: 'add', buf, clear }, [buf.buffer])
	}
	/** @param {JobKind} jobKind */
	wait(jobKind) {
		const job = this._jobs[jobKind]
		return job ? job.promise : Promise.resolve()
	}
	/** @param {JobKind} jobKind */
	isWorkingOn(jobKind) {
		return !!this._jobs[jobKind]
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
 * @template {unknown[]} TInArgs
 * @template {unknown[]} TMergedArgs
 * @param {(mergedArgs:TMergedArgs|null, newArgs:TInArgs) => TMergedArgs} mergeArgsFunc
 * @param {(...args:TMergedArgs) => void} func
 * @param {number} interval
 * @returns {(...args:TInArgs) => void}
 */
export function debounce(mergeArgsFunc, func, interval) {
	let timeout = /** @type {number|null} */ (null)
	let mergedArgs = /** @type {TMergedArgs|null} */ (null)
	return (...args) => {
		mergedArgs = mergeArgsFunc(mergedArgs, args)
		if (timeout !== null) clearTimeout(timeout)
		timeout = setTimeout(() => {
			timeout = null
			func(.../**@type {TMergedArgs}*/ (mergedArgs))
		}, interval)
	}
}

/**
 * @returns {{resolve():void, promise:Promise<any>}}
 */
export function makeSimpleDeferredPromise() {
	/**@type {*}*/
	let resolve
	const promise = new Promise(res => {
		resolve = res
	})
	return { resolve, promise }
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
