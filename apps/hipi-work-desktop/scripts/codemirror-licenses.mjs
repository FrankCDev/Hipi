import { createReviewedLicenseSet } from "./reviewed-licenses.mjs";

// These review pins stay independent of the editable source manifest.
export const codeMirrorInventorySha256 = "69b453d0585d6114cd4eba1fa752bde1d021fb932d054cf365608213c36e138e";
const licenses = createReviewedLicenseSet({
	label: "CodeMirror",
	vendorDirectory: "codemirror",
	inventoryUrl: new URL("../../hipi-work-ui/vendor/codemirror/inventory.json", import.meta.url),
	inventorySha256: codeMirrorInventorySha256,
	readmeSha256: "66a26191e8037f16f291f82e27a2da23d8aaf06e254b565f00ee5e6da207f333",
	protectedNames: /^@(?:codemirror|lezer)\//,
});
export const codeMirrorPackages = licenses.packages;
export const codeMirrorLicenseAssets = licenses.assets;
export const assertCodeMirrorLicenseAsset = licenses.assertAsset;
export const readCodeMirrorLicenseFiles = licenses.readFiles;
export const prepareCodeMirrorLicenses = licenses.prepare;
export const assertCodeMirrorDependencies = licenses.assertDependencies;
export const codeMirrorPackageForOwner = licenses.packageForOwner;
