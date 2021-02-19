/** @typedef {[iters:number, samples:number, cOffset:number, pointsMode:string, colorMode:string, newMtx:Float64Array]} RenderArgsArr */

/** @typedef {{cmd:'render', w:number, h:number, reset:{seed:number}|null, args:RenderArgsArr}} RenderMsg */
/** @typedef {{cmd:'rendered'}} RenderedMsg */

/** @typedef {{cmd:'add', buf:Uint32Array, clear:boolean}} AddMsg */
/** @typedef {{cmd:'added', buf:Uint32Array}} AddedMsg */

/** @typedef {RenderMsg|AddMsg} RequestMsg */
/** @typedef {RenderedMsg|AddedMsg} ResponseMsg */

const wasmPromise = (async () => {
	const { instance } = await WebAssembly.instantiateStreaming(fetch('./render.wasm'))
	const exports = instance.exports

	const WA_memory = mustBeInstanceOf(exports.memory, WebAssembly.Memory)
	const WA_get_required_memory_size = /** @type {(iters:number, w:number, h:number) => number} */ (exports.get_required_memory_size)
	const WA_render = /** @type {(w:number, h:number, iters:number, samples:number, cOffset:number, pointsMode:number, colorMode:number) => void} */ (exports.render)
	const WA_srand = /** @type {(seed:number) => void} */ (exports.srand)
	// const WA_rand_core_ptr = /** @type {() => number} */ (exports.get_rand_core_ptr)()
	const WA_color_buf_ptr = /** @type {() => number} */ (exports.get_color_buf_ptr)()
	const WA_clear_color_buf = /** @type {(w:Number, h:number) => void} */ (exports.clear_color_buf)
	const WA_transform_matrix_ptr = /** @type {() => number} */ (exports.get_transform_matrix_ptr)()

	function ensureMemSize(w, h, iters) {
		const delta = WA_get_required_memory_size(iters, w, h) - WA_memory.buffer.byteLength
		const deltaPages = Math.ceil(delta / 65536)
		if (deltaPages > 0) WA_memory.grow(deltaPages)
	}

	function getConstVal(name) {
		return new DataView(WA_memory.buffer).getInt32(getExportedNumber(exports, name), true)
		// return new Int32Array(WA_memory.buffer, getExportedNumber(exports, name))[0]
	}

	return {
		/**
		 * @param {number} w
		 * @param {number} h
		 * @param {number} seed
		 */
		reset(w, h, seed) {
			ensureMemSize(w, h, 0)
			WA_clear_color_buf(w, h)
			WA_srand(seed)
		},
		/**
		 * @param {number} w
		 * @param {number} h
		 * @param {number} iters
		 * @param {number} samples
		 * @param {number} cOffset
		 * @param {string} pointsMode
		 * @param {string} colorMode
		 * @param {Float64Array} newMtx
		 */
		render(w, h, iters, samples, cOffset, pointsMode, colorMode, newMtx) {
			ensureMemSize(w, h, iters)

			const mtx = new Float64Array(WA_memory.buffer, WA_transform_matrix_ptr, 8)
			mtx.set(newMtx)

			const pointsModeIndex = getConstVal('PM_' + pointsMode)
			const colorModeIndex = getConstVal('CM_' + colorMode)
			console.time('render')
			WA_render(w, h, iters, samples, cOffset, pointsModeIndex, colorModeIndex)
			console.timeEnd('render')
		},
		/**
		 * @param {Uint32Array} buf
		 */
		setColorBufTo(buf) {
			const src = new Uint32Array(WA_memory.buffer, WA_color_buf_ptr, buf.length)
			buf.set(src)
		},
		/**
		 * @param {Uint32Array} buf
		 */
		addColorBufTo(buf) {
			const src = new Uint32Array(WA_memory.buffer, WA_color_buf_ptr, buf.length)
			for (let i = 0; i < src.length; i++) {
				buf[i] += src[i]
			}
		},
	}
})()

self.onmessage = async e => {
	const data = /**@type {RequestMsg}*/ (e.data)
	if (data.cmd === 'render') {
		const { w, h, reset, args } = data
		const wasm = await wasmPromise

		if (reset) wasm.reset(w, h, reset.seed)
		wasm.render(w, h, ...args)

		const params = /** @type {RenderedMsg} */ ({ cmd: 'rendered' })
		// @ts-ignore
		self.postMessage(params, [])
	} else if (data.cmd === 'add') {
		const { buf, clear } = data
		const wasm = await wasmPromise

		if (clear) wasm.setColorBufTo(buf)
		else wasm.addColorBufTo(buf)

		const params = /** @type {AddedMsg} */ ({ cmd: 'added', buf })
		// @ts-ignore
		self.postMessage(params, [buf.buffer])
	}
}

/**
 * @template {{ new (...args: any): any }[]} T
 * @param {unknown} obj
 * @param  {T} classes
 * @returns {InstanceType<T[number]>}
 */
function mustBeInstanceOf(obj, ...classes) {
	for (const class_ of classes) {
		if (obj instanceof class_) return obj
	}
	throw new Error(`object must be ${classes.map(x => x.name).join('|')}, got ${obj}`)
}

/**
 * @param {Record<string, WebAssembly.ExportValue>} exports
 * @param {string} name
 * @returns {number}
 */
function getExportedNumber(exports, name) {
	const val = exports[name]
	if (val === undefined) throw new Error(`'${name}' is not exported`)
	if (!(val instanceof WebAssembly.Global)) throw new Error(`'${name}' is not global`)
	return val.value
}

// костыль, иначе import('./worker.js') в описании типов ругается, мол этот файл - не модуль
if (false) module.exports = {}
