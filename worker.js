const wasm = (async () => {
	const { instance } = await WebAssembly.instantiateStreaming(fetch('./render.wasm'))
	const exports = instance.exports

	const WA_memory = mustBeInstanceOf(exports.memory, WebAssembly.Memory)
	const WA_get_required_memory_size = /** @type {(iters:number, w:number, h:number) => number} */ (exports.get_required_memory_size)
	const WA_render = /** @type {(w:number, h:number, iters:number, samples:number) => void} */ (exports.render)
	const WA_srand = /** @type {(seed:number) => void} */ (exports.srand)
	const WA_color_buf_ptr = /** @type {() => number} */ (exports.get_color_buf_ptr)()
	const WA_transform_matrix_ptr = /** @type {() => number} */ (exports.get_transform_matrix_ptr)()

	function ensureMemSize(w, h, iters) {
		const delta = WA_get_required_memory_size(iters, w, h) - WA_memory.buffer.byteLength
		const deltaPages = Math.ceil(delta / 65536)
		if (deltaPages > 0) WA_memory.grow(deltaPages)
	}

	return {
		render(w, h, seed, iters, samples, newMtx) {
			ensureMemSize(w, h, iters)
			const mtx = new Float64Array(WA_memory.buffer, WA_transform_matrix_ptr, 8)
			mtx.set(newMtx)
			const buf = new Uint32Array(WA_memory.buffer, WA_color_buf_ptr, w * h * 3)
			buf.fill(0)
			WA_srand(seed)
			console.time('render')
			WA_render(w, h, iters, samples)
			console.timeEnd('render')
			return buf
		},
		srand(seed) {
			WA_srand(seed)
		},
	}
})()

self.onmessage = async e => {
	// console.log(e.data[0])
	// postMessage(e.data, [e.data[0].buffer])
	if (e.data.cmd === 'render') {
		const { w, h, buf, seed, args } = e.data
		const pixBuf = (await wasm).render(w, h, seed, ...args)
		buf.set(pixBuf)
		// console.log('rendered', w, h)
		// @ts-ignore
		self.postMessage({ cmd: 'rendered', buf }, [buf.buffer])
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
