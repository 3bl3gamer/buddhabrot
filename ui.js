import { getById, mustBeNotNull, throttle } from './utils.js'

/**
 * @typedef {{
 *   size: number,
 *   samples: number,
 *   iters: number,
 *   rotX: number,
 *   rotY: number,
 *   rotationMode: 'a-b-cx'|'a-b-cy'|'cx-cy-a'|'cx-cy-b'
 * }} Opts
 */

let form = /** @type {HTMLFormElement|null} */ (null)
function getForm() {
	return (form = form || getById('cfg-form', HTMLFormElement))
}

/**
 * @param {(opts: Opts, targetName: string|null) => unknown} onChange
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

	/** @returns {Opts} */
	function getOpts() {
		const data = new FormData(form)
		return {
			size: [256, 512, 1024, 2048, 4096][+(data.get('size') ?? 0)],
			samples: (parseInt(/**@type {*}*/ (data.get('samples'))) || 1000) * 1000,
			iters: parseInt(/**@type {*}*/ (data.get('iters'))) || 100,
			rotX: (parseFloat(/**@type {*}*/ (data.get('rot-x')) || 0) / 180) * Math.PI,
			rotY: (parseFloat(/**@type {*}*/ (data.get('rot-y')) || 0) / 180) * Math.PI,
			rotationMode: /**@type {*}*/ (data.get('rotation-mode')),
		}
	}
	function applyOpts(/** @type {Opts} */ opts) {
		getById('screen-size-box', HTMLSpanElement).textContent = opts.size + ''
	}

	getForm().oninput = e => {
		const opts = getOpts()
		onChange(opts, e.target && 'name' in e.target ? e.target['name'] : null)
		applyOpts(opts)
	}
	setTimeout(() => applyOpts(getOpts()), 1)
	return getOpts()
}

export const updateRotationInputs = throttle(
	/**
	 * @param {number} rotX
	 * @param {number} rotY
	 */
	(rotX, rotY) => {
		const form = getForm()
		form['rot-x'].value = ((rotX / Math.PI) * 180).toFixed(2)
		form['rot-y'].value = ((rotY / Math.PI) * 180).toFixed(2)
	},
	500,
)

export const updateStatus = (() => {
	const progressBox = getById('progress-box', HTMLDivElement)
	const bar = /** @type {HTMLElement} */ (mustBeNotNull(progressBox.querySelector('.bar')))
	const threadsBox = getById('threads-box', HTMLSpanElement)
	/**
	 * @param {number} progress
	 * @param {number} curThreads
	 * @param {number} maxThreads
	 */
	return (progress, curThreads, maxThreads) => {
		bar.style.width = progress * 100 + '%'
		threadsBox.textContent = curThreads + '/' + maxThreads
	}
})()
