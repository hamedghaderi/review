import type { KeyboardEvent } from 'react'
import { tabEdit } from '../../shared/indent.ts'

/**
 * Tab and Shift+Tab in a Markdown text box indent and outdent instead of moving focus (see `tabEdit`). Typed through
 * the browser's own editing so ⌘Z undoes it and React's onChange sees it. Returns true when it handled the key; when
 * there's nothing to change, focus moves as usual. Call it after the GIF and mention pickers, which use Tab to pick.
 */
export function tabKey(e: KeyboardEvent<HTMLTextAreaElement>): boolean {
	if (e.key !== 'Tab' || e.ctrlKey || e.metaKey || e.altKey || e.nativeEvent.isComposing) return false
	const el = e.currentTarget
	if (el.readOnly || el.disabled) return false
	const edit = tabEdit(el.value, el.selectionStart, el.selectionEnd, e.shiftKey)
	if (!edit) return false
	e.preventDefault()
	el.setSelectionRange(edit.from, edit.to)
	if (!document.execCommand(edit.insert ? 'insertText' : 'delete', false, edit.insert)) {
		el.setRangeText(edit.insert)
		el.dispatchEvent(new Event('input', { bubbles: true }))
	}
	el.setSelectionRange(edit.selStart, edit.selEnd)
	return true
}
