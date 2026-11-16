/**
 * Who said a message in an AI conversation, for screen readers only (issue #218): the layout and colours show it on
 * screen, and a heading lets you jump from message to message. Messages are articles, not landmarks, so a long
 * conversation doesn't fill the landmark list.
 */
export function SpeakerHeading({ children }: { children: string }) {
	return <h3 className="sr-only">{children}</h3>
}
