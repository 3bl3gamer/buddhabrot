import { debounce, getById, mustBeNotNull, throttle } from './utils.js'

/**
 * @typedef {{
 *   size: number,
 *   samples: number,
 *   iters: number,
 *   cOffset: number,
 *   rotX: number,
 *   rotY: number,
 *   zoom: number,
 *   rotationMode: 'a-b-cx'|'a-b-cy'|'cx-cy-a'|'cx-cy-b',
 *   pointsMode: 'inner'|'outer',
 *   colorMode: 'white_black'|'hue_atan_red'|'hue_atan_blue'|'hue_atan_green'|'hue_atan_asymm'|'hue_iters'|'rgb_layers',
 *   contrast: number,
 * }} Opts
 */

let form = /** @type {HTMLFormElement|null} */ (null)
function getForm() {
	return (form = form || getById('cfg-form', HTMLFormElement))
}

const excludedUrlParams = ['size']
const updateURL = debounce(
	/**
	 * @param {[boolean]|null} prevArgs
	 * @param {[boolean]} args
	 * @returns {[boolean]}
	 */
	(prevArgs, args) => [(!!prevArgs && prevArgs[0]) || args[0]],
	usePush => {
		const data = new FormData(getForm())
		for (const name of excludedUrlParams) data.delete(name)
		const hash = '#' + new URLSearchParams(/**@type {*}*/ (data)).toString()
		if (usePush) history.pushState({}, '', hash)
		else history.replaceState({}, '', hash)
	},
	500,
)

/**
 * @param {(opts: Opts, targetName: string|null) => unknown} onChange
 * @returns {Opts}
 */
export function initUI(onChange) {
	function toggleCfg(on) {
		document.body.classList.toggle('cfg-minimized', on)
	}
	getById('cfg-hide-button', HTMLButtonElement).onclick = () => toggleCfg(true)
	getById('cfg-show-button', HTMLButtonElement).onclick = () => toggleCfg(false)
	addEventListener('keydown', e => {
		if (e.key === 'Escape') toggleCfg()
	})

	/** @returns {Opts} */
	function getOpts() {
		const data = new FormData(getForm())
		return {
			size: [256, 512, 1024, 2048, 4096][+(data.get('size') ?? 0)],
			samples: (parseInt(/**@type {*}*/ (data.get('samples'))) || 1000) * 1000,
			iters: parseInt(/**@type {*}*/ (data.get('iters'))) || 100,
			cOffset: parseInt(/**@type {*}*/ (data.get('c-offset'))) || 0,
			rotX: (parseFloat(/**@type {*}*/ (data.get('rot-x')) || 0) / 180) * Math.PI,
			rotY: (parseFloat(/**@type {*}*/ (data.get('rot-y')) || 0) / 180) * Math.PI,
			zoom: parseFloat(/**@type {*}*/ (data.get('zoom')) || 1),
			rotationMode: /**@type {*}*/ (data.get('rotation-mode')),
			pointsMode: /**@type {*}*/ (data.get('points-mode')),
			colorMode: /**@type {*}*/ (data.get('color-mode')),
			contrast: parseFloat(/**@type {*}*/ (data.get('contrast')) || 1),
		}
	}
	function applyOpts(/** @type {Opts} */ opts) {
		getById('screen-size-box', HTMLSpanElement).textContent = opts.size + ''
	}
	function applyCurrentHash() {
		const form = getForm()
		// restoring defaults
		for (const elem of form.querySelectorAll('input'))
			if (!excludedUrlParams.includes(elem.name))
				if (elem.type === 'radio') {
					elem.checked = elem.getAttribute('checked') !== null
				} else {
					elem.value = elem.getAttribute('value') || ''
				}
		// setting params
		const params = new URLSearchParams(location.hash.substr(1))
		for (const [key, val] of params.entries()) {
			const elem = form[key]
			if (elem instanceof HTMLInputElement || elem instanceof RadioNodeList) elem.value = val
		}
	}

	addEventListener('hashchange', () => {
		applyCurrentHash()
		const opts = getOpts()
		onChange(opts, 'all')
		applyOpts(opts)
	})

	getForm().oninput = e => {
		const opts = getOpts()
		const targetName = e.target && 'name' in e.target ? e.target['name'] : null
		onChange(opts, targetName)
		applyOpts(opts)
		if (!excludedUrlParams.includes(targetName))
			updateURL(!['rot-x', 'rot-y', 'zoom'].includes(targetName))
	}
	// setTimeout(() => applyOpts(getOpts()), 1)
	applyOpts(getOpts())
	if (location.hash.length > 1) applyCurrentHash()
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
		updateURL(false)
	},
	250,
)

export const updateZoomInput = throttle(
	/** @param {number} zoom */
	zoom => {
		const form = getForm()
		form['zoom'].value = zoom.toFixed(2)
		updateURL(false)
	},
	250,
)

export const updateStatus = (() => {
	const progressBox = getById('progress-box', HTMLDivElement)
	const bar = /** @type {HTMLElement} */ (mustBeNotNull(progressBox.querySelector('.bar')))
	const renderSpeedBox = getById('render-speed-box', HTMLSpanElement)
	const threadsBox = getById('threads-box', HTMLSpanElement)
	/**
	 * @param {number} progress
	 * @param {number} startStamp
	 * @param {number} curThreads
	 * @param {number} maxThreads
	 */
	function updateStatus(progress, startStamp, curThreads, maxThreads) {
		bar.style.width = progress * 100 + '%'
		const elapsed = Date.now() - startStamp
		// if rendering still image long enough (otherwise updateFPS() will show fps here)
		if (elapsed > 1000)
			renderSpeedBox.textContent =
				progress === 0
					? '∞'
					: progress < 1
					? 'осталось: ' + (((elapsed / progress) * (1 - progress)) / 1000).toFixed(0) + ' с'
					: 'время: ' + (elapsed / progress / 1000).toFixed(1) + ' с'
		threadsBox.textContent = curThreads + '/' + maxThreads
	}
	return updateStatus
})()

export function updateFPS(fps) {
	getById('render-speed-box', HTMLSpanElement).textContent = 'FPS: ' + fps.toFixed(1)
}
