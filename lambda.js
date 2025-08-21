const { codeCompile } = require("./codeCompile");

exports.handler = async (event) => {
    try {
        console.log(event);
        return await codeCompile(event);
	} catch (e) {
		console.log("error", e);
		return { error: e.message };
	}
};
