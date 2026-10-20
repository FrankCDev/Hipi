import { createReviewedLicenseSet } from "./reviewed-licenses.mjs";

// These review pins stay independent of the editable source manifest.
export const pierreInventorySha256 = "35168f65190a59902d4aa683abed85a5972c5c39f3352649b92f3741a4053e28";
const licenses = createReviewedLicenseSet({
	label: "Pierre",
	vendorDirectory: "pierre",
	inventoryUrl: new URL("../../hipi-work-ui/vendor/pierre/inventory.json", import.meta.url),
	inventorySha256: pierreInventorySha256,
	readmeSha256: "78137b9128f1f039a6116ec50e0e6f8322a4d36b09466a64e36fdb13459775e1",
	protectedNames: /^(?:@(?:pierre|shikijs)\/|shiki$)/,
});
export const pierrePackages = licenses.packages;
export const pierreLicenseAssets = licenses.assets;
export const assertPierreLicenseAsset = licenses.assertAsset;
export const readPierreLicenseFiles = licenses.readFiles;
export const preparePierreLicenses = licenses.prepare;
export const assertPierreDependencies = licenses.assertDependencies;
export const pierrePackageForOwner = licenses.packageForOwner;
