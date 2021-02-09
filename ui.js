import { getById } from './utils.js'

/**
 * @typedef {{
 *   size: number,
 *   rotationMode: 'a-b-cx'|'a-b-cy'|'cx-cy-a'|'cx-cy-b'
 * }} Opts
 */

/**
 * @param {(opts: Opts) => unknown} onChange
 * @returns {Opts}
 */
export function initUI(onChange) {
	function toggleCfg(on) {
		getById('cfg-wrap', HTMLDivElement).classList.toggle('minimized', on)
	}
	getById('cfg-hide-button', HTMLButtonElement).onclick = () => toggleCfg(true)
	getById('cfg-show-button', HTMLButtonElement).onclick = () => toggleCfg(false)
	addEventListener('keydown', e => {
		if (e.key === 'Escape') toggleCfg()
	})

	function getOpts() {
		const data = new FormData(form)
		return /** @type {Opts} */ ({
			size: [256, 512, 1024, 2048, 4096][+(data.get('size') ?? 0)],
			rotationMode: data.get('rotation-mode'),
		})
	}
	function applyOpts(/** @type {Opts} */ opts) {
		getById('screen-size-box', HTMLSpanElement).textContent = opts.size + ''
	}

	const form = getById('cfg-form', HTMLFormElement)
	form.oninput = e => {
		const opts = getOpts()
		onChange(opts)
		applyOpts(opts)
	}
	setTimeout(() => applyOpts(getOpts()), 1)
	return getOpts()
}
