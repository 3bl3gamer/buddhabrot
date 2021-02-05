import { getById } from './utils.js'

/**
 * @typedef {{
 *   'rotation-mode': 'a-b-cx'|'a-b-cy'|'a-cx-cy'|'b-cx-cy'|'all'
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

	const getOpts = () => /** @type {Opts} */ (Object.fromEntries(new FormData(form)))

	const form = getById('cfg-form', HTMLFormElement)
	form.onchange = e => {
		onChange(getOpts())
	}
	return getOpts()
}
