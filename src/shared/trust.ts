/**
 * Who on a pull request counts as speaking for the repository. GitHub reports each author's role as an
 * `authorAssociation`; OWNER and COLLABORATOR have write access, and MEMBER (of the owning organization) is treated
 * the same, though an organization can give members read access only. Everyone else, and anyone whose role wasn't
 * read, is an outsider: what they write is sent to the AI as data, but it can't settle a finding or unlock MCP tools.
 */
const WRITE_ROLES: ReadonlySet<string> = new Set(['OWNER', 'MEMBER', 'COLLABORATOR'])

export function hasWriteRole(association: string | null | undefined): boolean {
	return !!association && WRITE_ROLES.has(association.toUpperCase())
}

/** How a comment's author is named to the AI: the PR author, someone with write access, or an outsider. */
export function roleOf(author: string | null, association: string | null | undefined, prAuthor: string | null): string {
	if (author && prAuthor && author.toLowerCase() === prAuthor.toLowerCase()) return 'PR author'
	return hasWriteRole(association) ? 'write access' : 'no write access'
}
