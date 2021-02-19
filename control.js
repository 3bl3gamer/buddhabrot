/** @typedef {[EventTarget, string, (e:any) => void]} Evt */

/**
 * @param {{
 *   startElem: Element,
 *   moveElem?: EventTarget|null,
 *   offsetElem?: Element|null,
 *   leaveElem?: EventTarget|null,
 *   callbacks: {
 *     singleDown?: (e:MouseEvent|TouchEvent, id:'mouse'|number, x:number, y:number, isSwitching:boolean) => boolean|void,
 *     singleMove?: (e:MouseEvent|TouchEvent, id:'mouse'|number, x:number, y:number) => void|boolean,
 *     singleUp?: (e:MouseEvent|TouchEvent, id:'mouse'|number, isSwitching:boolean) => void|boolean,
 *     singleHover?: (e:MouseEvent, x:number, y:number) => void|boolean,
 *     singleLeave?: (e:MouseEvent, x:number, y:number) => void|boolean,
 *     doubleDown?: (e:TouchEvent, id0:number, x0:number, y0:number, id1:number, x1:number, y1:number, isSwitching:boolean) => void|boolean,
 *     doubleMove?: (e:TouchEvent, id0:number, x0:number, y0:number, id1:number, x1:number, y1:number) => void|boolean,
 *     doubleUp?: (e:TouchEvent, id0:number, id1:number, isSwitching:boolean) => void|boolean,
 *     wheelRot?: (e:WheelEvent, deltaX:number, deltaY:number, deltaZ:number, x:number, y:number) => void|boolean,
 *   },
 * }} params
 */
export function controlDouble(params) {
	const { startElem, callbacks } = params
	const moveElem = params.moveElem ?? window
	const offsetElem = params.offsetElem ?? startElem
	const leaveElem = params.leaveElem ?? startElem

	const { singleDown = noop, singleMove = noop, singleUp = noop } = callbacks
	const { doubleDown = noop, doubleMove = noop, doubleUp = noop } = callbacks
	const { singleHover = noop, singleLeave = noop, wheelRot = noop } = callbacks

	const touchIds = /** @type {number[]} */ ([])

	function getOffsetRect() {
		return offsetElem.getBoundingClientRect()
	}
	/**
	 * @template {Event} T
	 * @param {(e:T, x:number, y:number) => boolean|void} func
	 * @returns {(e:T) => void}
	 */
	function wrap(func) {
		return e => {
			const rect = getOffsetRect()
			func(e, -rect.left, -rect.top) && e.preventDefault()
		}
	}

	const mousedown = wrap(function mousedown(/** @type {MouseEvent} */ e, dx, dy) {
		if (e.button != 0) return false
		addListener(mouseMoveEvt)
		addListener(mouseUpEvt)
		removeListener(mouseHoverEvt)
		return singleDown(e, 'mouse', e.clientX + dx, e.clientY + dy, false)
	})

	const mousemove = wrap(function mousemove(/** @type {MouseEvent} */ e, dx, dy) {
		return singleMove(e, 'mouse', e.clientX + dx, e.clientY + dy)
	})

	const mouseup = wrap(function mouseup(/** @type {MouseEvent} */ e, dx, dy) {
		if (e.button != 0) return false
		removeListener(mouseMoveEvt)
		removeListener(mouseUpEvt)
		addListener(mouseHoverEvt)
		return singleUp(e, 'mouse', false)
	})

	const mousemoveHover = wrap(function mousemoveHover(/** @type {MouseEvent} */ e, dx, dy) {
		return singleHover(e, e.clientX + dx, e.clientY + dy)
	})

	const mouseleave = wrap(function mouseleave(/** @type {MouseEvent} */ e, dx, dy) {
		return singleLeave(e, e.clientX + dx, e.clientY + dy)
	})

	const touchstart = wrap(function touchstart(/** @type {TouchEvent} */ e, dx, dy) {
		const count = touchIds.length
		if (count == 2) return false

		if (count == 0) {
			addListener(touchMoveEvt)
			addListener(touchEndEvt)
			addListener(touchCancelEvt)
		}

		if (count == 0 && e.changedTouches.length == 1) {
			const t = e.changedTouches[0]
			touchIds.push(t.identifier)
			return singleDown(e, touchIds[0], t.clientX + dx, t.clientY + dy, false)
		}
		if (count == 0 && e.changedTouches.length >= 2) {
			const ts = e.changedTouches
			touchIds.push(ts[0].identifier)
			touchIds.push(ts[1].identifier)
			const x0 = ts[0].clientX + dx
			const y0 = ts[0].clientY + dy
			const x1 = ts[1].clientX + dx
			const y1 = ts[1].clientY + dy
			return doubleDown(e, touchIds[0], x0, y0, touchIds[1], x1, y1, false)
		}
		if (count == 1) {
			const t0 = mustFindTouch(e.touches, touchIds[0])
			const t1 = e.changedTouches[0]
			touchIds.push(t1.identifier)
			const x0 = t0.clientX + dx
			const y0 = t0.clientY + dy
			const x1 = t1.clientX + dx
			const y1 = t1.clientY + dy
			const prevent0 = singleUp(e, touchIds[0], true)
			const prevent1 = doubleDown(e, touchIds[0], x0, y0, touchIds[1], x1, y1, true)
			return prevent0 || prevent1
		}
	})

	const touchmove = wrap(function touchmove(/** @type {TouchEvent} */ e, dx, dy) {
		const count = touchIds.length
		if (count == 1) {
			const t0 = mustFindTouch(e.changedTouches, touchIds[0])
			return singleMove(e, touchIds[0], t0.clientX + dx, t0.clientY + dy)
		}
		if (count == 2) {
			// can not use e.changedTouches: one of touches may have not changed
			const t0 = mustFindTouch(e.touches, touchIds[0])
			const t1 = mustFindTouch(e.touches, touchIds[1])
			const x0 = t0.clientX + dx
			const y0 = t0.clientY + dy
			const x1 = t1.clientX + dx
			const y1 = t1.clientY + dy
			return doubleMove(e, touchIds[0], x0, y0, touchIds[1], x1, y1)
		}
	})

	const releasedTouches = /** @type {Touch[]} */ ([])
	const touchend = wrap(function touchend(/** @type {TouchEvent} */ e, dx, dy) {
		const count = touchIds.length

		releasedTouches.length = 0
		for (let j = touchIds.length - 1; j >= 0; j--) {
			for (let i = 0; i < e.changedTouches.length; i++) {
				const t = e.changedTouches[i]
				if (t.identifier === touchIds[j]) {
					touchIds.splice(j, 1)
					releasedTouches.push(t)
				}
			}
		}

		if (count === releasedTouches.length) {
			removeListener(touchMoveEvt)
			removeListener(touchEndEvt)
			removeListener(touchCancelEvt)
		}

		if (count === 1 && releasedTouches.length === 1) {
			return singleUp(e, releasedTouches[0].identifier, false)
		}
		if (count == 2 && releasedTouches.length === 2) {
			return doubleUp(e, releasedTouches[0].identifier, releasedTouches[1].identifier, false)
		}
		if (count == 2 && releasedTouches.length === 1) {
			const id0 = touchIds[0]
			const t0 = mustFindTouch(e.touches, id0)
			const t1 = releasedTouches[0]
			const prevent0 = doubleUp(e, id0, t1.identifier, true)
			const prevent1 = singleDown(e, t0.identifier, t0.clientX + dx, t0.clientY + dy, true)
			return prevent0 || prevent1
		}
	})

	const touchcancel = wrap(function touchcancel(/** @type {TouchEvent} */ e, dx, dy) {
		touchend(e)
	})

	const deltaMode2pixels = []
	deltaMode2pixels[WheelEvent.DOM_DELTA_PIXEL] = 1
	deltaMode2pixels[WheelEvent.DOM_DELTA_LINE] = 20
	deltaMode2pixels[WheelEvent.DOM_DELTA_PAGE] = 50 // а это вообще как?
	const mousewheel = wrap(function mousewheel(/** @type {WheelEvent} */ e, dx, dy) {
		const k = deltaMode2pixels[e.deltaMode]
		return wheelRot(e, e.deltaX * k, e.deltaY * k, e.deltaZ * k, e.clientX + dx, e.clientY + dy)
	})

	const mouseDownEvt = /** @type {Evt} */ ([startElem, 'mousedown', mousedown])
	const mouseMoveEvt = /** @type {Evt} */ ([moveElem, 'mousemove', mousemove])
	const mouseUpEvt = /** @type {Evt} */ ([moveElem, 'mouseup', mouseup])
	const wheelEvt = /** @type {Evt} */ ([startElem, 'wheel', mousewheel])
	const mouseHoverEvt = /** @type {Evt} */ ([startElem, 'mousemove', mousemoveHover])
	const mouseLeaveEvt = /** @type {Evt} */ ([leaveElem, 'mouseleave', mouseleave])
	const touchStartEvt = /** @type {Evt} */ ([startElem, 'touchstart', touchstart])
	const touchMoveEvt = /** @type {Evt} */ ([moveElem, 'touchmove', touchmove])
	const touchEndEvt = /** @type {Evt} */ ([moveElem, 'touchend', touchend])
	const touchCancelEvt = /** @type {Evt} */ ([moveElem, 'touchcancel', touchcancel])
	// prettier-ignore
	const events = [
		mouseDownEvt, mouseMoveEvt, mouseUpEvt, mouseHoverEvt, mouseLeaveEvt,
		touchStartEvt, touchMoveEvt, touchEndEvt, touchCancelEvt,
	]
	const autoOnEvents = [mouseDownEvt, touchStartEvt, mouseHoverEvt, mouseLeaveEvt, wheelEvt]

	let isOn = false
	/** @param {boolean|null|undefined} on */
	function toggle(on) {
		on = on ?? !isOn
		if (isOn === on) return
		if (on) autoOnEvents.map(addListener)
		else events.map(removeListener)
		isOn = on
	}

	toggle(true)
	return {
		toggle,
		on() {
			toggle(true)
		},
		off() {
			toggle(false)
		},
	}
}

function noop() {}

/**
 * @param {TouchList} list
 * @param {number} id
 */
function findTouch(list, id) {
	for (let i = 0; i < list.length; i++) if (list[i].identifier === id) return list[i]
	return null
}
/**
 * @param {TouchList} list
 * @param {number} id
 */
function mustFindTouch(list, id) {
	const touch = findTouch(list, id)
	if (touch === null) throw new Error(`touch #${id} not found`)
	return touch
}

/** @param {Evt} event */
function addListener(event) {
	event[0].addEventListener(event[1], event[2], { capture: true, passive: false })
}

/** @param {Evt} event */
function removeListener(event) {
	event[0].removeEventListener(event[1], event[2], { capture: true })
}
