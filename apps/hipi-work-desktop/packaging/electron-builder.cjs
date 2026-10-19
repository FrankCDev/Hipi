const path = require("node:path");
const desktop = path.resolve(__dirname, "..");
const root = path.resolve(desktop, "../..");
const manifest = require(path.join(desktop, "package.json"));

module.exports = {
	appId: "org.hipi.work",
	productName: "Hipi Work",
	electronVersion: manifest.devDependencies.electron,
	electronDownload: { cache: path.join(root, ".artifacts/hipi-work/cache/electron") },
	directories: {
		app: path.join(root, ".artifacts/hipi-work/app"),
		output: path.join(root, ".artifacts/hipi-work/packages"),
	},
	artifactName: "Hipi-Work-${version}-${os}-${arch}-unsigned.${ext}",
	asar: true,
	asarUnpack: ["dist/runtime.mjs", "dist/preview-parser.mjs", "dist/maintenance.mjs"],
	files: ["dist/**", "licenses/**", "LICENSE", "package.json", "dependency-licenses.json", "build-provenance.json", "!**/*.map", "!**/*.meta.json"],
	npmRebuild: false,
	nodeGypRebuild: false,
	buildDependenciesFromSource: false,
	publish: null,
	afterPack: path.join(__dirname, "verify-pack.cjs"),
	mac: {
		icon: path.join(desktop, "branding/icon.icns"),
		target: ["dmg", "zip"], category: "public.app-category.productivity",
		identity: null, notarize: false,
	},
	win: { target: ["nsis", "zip"], icon: path.join(desktop, "branding/icon.ico"), signExecutable: false },
	nsis: { oneClick: false, perMachine: false, allowToChangeInstallationDirectory: true, deleteAppDataOnUninstall: false },
	linux: { target: ["AppImage", "tar.gz"], icon: path.join(desktop, "branding/png"), category: "Utility", executableName: "hipi-work", syncDesktopName: true },
};
