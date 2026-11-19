// Vite: the built address of a worker script, to start it ourselves (see sandboxedWorker).
declare module '*?worker&url' {
	const url: string
	export default url
}
