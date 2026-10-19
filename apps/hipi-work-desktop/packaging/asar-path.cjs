const path = require("node:path");

// ASAR's filesystem traversal splits directories by the host separator, even
// though our portable provenance always records POSIX paths.
module.exports = function asarLookupPath(file, pathApi = path) {
	return file.split("/").join(pathApi.sep);
};
