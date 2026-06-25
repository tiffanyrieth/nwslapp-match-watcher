// Non-JS imports resolved by Wrangler's module rules.
// `.woff` → Data module (ArrayBuffer); `.wasm` → CompiledWasm (WebAssembly.Module).
declare module "*.woff" {
	const data: ArrayBuffer;
	export default data;
}
declare module "*.wasm" {
	const mod: WebAssembly.Module;
	export default mod;
}
