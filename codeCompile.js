const fs = require("fs");
const { spawn } = require("child_process");
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const os = require("os");

const RUN_TIMEOUT_MS = 60000;
const COMPILE_TIMEOUT_MS = 60000;
const MEMORY_LIMIT_KB = 256 * 1024;
const MAX_OUTPUT_LENGTH = 512 * 1024;

function safeSpawn(cmd, args, options = {}) {
	return spawn(cmd, args, Object.assign({ stdio: ["pipe", "pipe", "pipe"], detached: true }, options));
}

function monitorLimits(child, timeoutMs, memoryLimitKb, getOutput, onLimit, onStats) {
	let finished = false;
	let peakMemory = 0;
	const startTime = Date.now();
	const timeout = setTimeout(() => {
		if (finished) return;
		finished = true;
		try {
			process.kill(-child.pid);
		} catch {}
		onLimit({ type: "Time limit exceeded", output: getOutput() });
	}, timeoutMs);
	const memInterval = setInterval(() => {
		if (finished) return;
		try {
			const status = fs.readFileSync(`/proc/${child.pid}/status`, "utf8");
			const m = status.match(/VmRSS:\s+(\d+)\s+kB/);
			if (m) {
				const currentMem = parseInt(m[1]);
				if (currentMem > peakMemory) peakMemory = currentMem;
				console.log(`[PID ${child.pid}] Memory: ${currentMem} KB`);
				if (currentMem > memoryLimitKb) {
					finished = true;
					try {
						process.kill(-child.pid);
					} catch {}
					clearTimeout(timeout);
					clearInterval(memInterval);
					onLimit({ type: "Memory limit exceeded", output: getOutput() });
				}
			}
		} catch (e) {}
	}, 500);

	return () => {
		clearTimeout(timeout);
		clearInterval(memInterval);
		if (!finished) {
			const durationMs = Date.now() - startTime;
			onStats({ peakMemory, durationMs });
		}
	};
}

function runProcess(cmd, args, cwd, input, timeoutMs, memoryLimitKb) {
	return new Promise((resolve, reject) => {
		const child = safeSpawn(cmd, args, { cwd });
		let stdout = "";
		let stderr = "";
		const getOutput = () => (stdout || stderr).slice(0, MAX_OUTPUT_LENGTH);
		child.stdout.on("data", (d) => {
			if (stdout.length < MAX_OUTPUT_LENGTH) {
				stdout += d.toString();
				if (stdout.length >= MAX_OUTPUT_LENGTH) {
					stdout += "\n...output truncated...\n";
					try {
						process.kill(-child.pid);
					} catch {}
					reject({ type: "Output Limit Exceeded", output: getOutput() });
				}
			}
		});

		child.stderr.on("data", (d) => {
			if (stderr.length < MAX_OUTPUT_LENGTH) {
				stderr += d.toString();
				if (stderr.length >= MAX_OUTPUT_LENGTH) {
					stderr += "\n...error output truncated...\n";
					try {
						process.kill(-child.pid);
					} catch {}
					reject({ type: "Error Limit Exceeded", output: getOutput() });
				}
			}
		});
		if (input && input.trim().length > 0 && child.stdin) {
			child.stdin.on("error", (err) => {
				if (err.code !== "EPIPE") console.error("stdin error:", err);
			});
			if (child.stdin.writable) {
				child.stdin.write(input, () => {
					try {
						child.stdin.end();
					} catch {}
				});
			}
		}

		const cleanupMonitor = monitorLimits(
			child,
			timeoutMs,
			memoryLimitKb,
			() => getOutput(),
			(msg) => reject(msg),
			({ peakMemory, durationMs }) => {
				console.log(
					`[PID ${child.pid}] Finished. Peak memory: ${peakMemory} KB, Time: ${durationMs} ms`
				);
			}
		);

		child.on("error", (err) => {
			cleanupMonitor();
			reject({ type: "Syntax Error", output: err.message || String(err) });
		});
		child.on("close", (code, signal) => {
			cleanupMonitor();
			if (code === 0) resolve(stdout);
			else {
				const errOut =
					stderr ||
					stdout ||
					`Process exited with code ${code}${signal ? ` signal:${signal}` : ""}`;
				reject({ type: "Error occurred", output: errOut });
			}
		});
	});
}

const codeCompile = async (event) => {
	try {
		const { code, language, input } = event;
		if (typeof code !== "string" || code.trim().length === 0)
			return { error: "Invalid or empty code provided" };
		if (language && typeof language !== "string") return { error: "Language must be a string" };
		if (input && typeof input !== "string") return { error: "Input must be a string" };

		console.log("\nprocessing for ", language);
		const totalMemMB = os.totalmem() / 1024 / 1024;
		const freeMemMB = os.freemem() / 1024 / 1024;
		const usedMemMB = totalMemMB - freeMemMB;
		console.log(`Total Memory: ${totalMemMB.toFixed(2)} MB`);
		console.log(`Free Memory: ${freeMemMB.toFixed(2)} MB`);
		console.log(`Used Memory: ${usedMemMB.toFixed(2)} MB`);

		const lang = (language || "javascript").toLowerCase();
		const id = uuidv4();
		const tempDir = path.join("/tmp", id);
		fs.mkdirSync(tempDir, { recursive: true });
		const inputPath = path.join(tempDir, "input.txt");
		fs.writeFileSync(inputPath, input || "");
		let sourceFile = null;
		let compileStep = null;
		let runStep = null;
		if (lang === "javascript" || lang === "js") {
			sourceFile = "program.js";
			fs.writeFileSync(path.join(tempDir, sourceFile), code);
			runStep = { cmd: "node", args: [path.join(tempDir, sourceFile)], timeout: RUN_TIMEOUT_MS };
		} else if (lang === "typescript" || lang === "ts") {
			sourceFile = "program.ts";
			fs.writeFileSync(path.join(tempDir, sourceFile), code);
			compileStep = {
				cmd: "npx",
				args: [
					"tsc",
					path.join(tempDir, sourceFile),
					"--outDir",
					tempDir,
					"--esModuleInterop",
					"--skipLibCheck",
				],
				timeout: COMPILE_TIMEOUT_MS,
			};
			runStep = { cmd: "node", args: [path.join(tempDir, "program.js")], timeout: RUN_TIMEOUT_MS };
		} else if (lang === "python" || lang === "python3") {
			sourceFile = "program.py";
			fs.writeFileSync(path.join(tempDir, sourceFile), code);
			runStep = { cmd: "python3", args: [path.join(tempDir, sourceFile)], timeout: RUN_TIMEOUT_MS };
		} else if (lang === "c" || lang === "c++" || lang === "cpp") {
			const isCpp = lang === "c++" || lang === "cpp";
			sourceFile = isCpp ? "program.cpp" : "program.c";
			fs.writeFileSync(path.join(tempDir, sourceFile), code);
			const compiler = isCpp ? "clang++" : "gcc";
			compileStep = {
				cmd: compiler,
				args: [path.join(tempDir, sourceFile), "-o", path.join(tempDir, "program")],
				timeout: COMPILE_TIMEOUT_MS,
			};
			runStep = { cmd: path.join(tempDir, "program"), args: [], timeout: RUN_TIMEOUT_MS };
		} else if (lang === "java") {
			sourceFile = "Program.java";
			fs.writeFileSync(path.join(tempDir, sourceFile), code);
			compileStep = {
				cmd: "javac",
				args: [path.join(tempDir, sourceFile)],
				timeout: COMPILE_TIMEOUT_MS,
			};
			runStep = { cmd: "java", args: ["-cp", tempDir, "Program"], timeout: RUN_TIMEOUT_MS };
		} else if (lang === "csharp" || lang === "c#") {
			sourceFile = "Program.cs";
			fs.writeFileSync(path.join(tempDir, sourceFile), code);
			const csproj = path.join(tempDir, "run.csproj");
			fs.writeFileSync(
				csproj,
				`<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>`
			);
			compileStep = {
				cmd: "dotnet",
				args: [
					"build",
					tempDir,
					"-o",
					path.join(tempDir, "out"),
					"--nologo",
					"--verbosity",
					"minimal",
				],
				timeout: COMPILE_TIMEOUT_MS,
			};
			runStep = {
				cmd: "dotnet",
				args: [path.join(tempDir, "out", "run.dll")],
				timeout: RUN_TIMEOUT_MS,
			};
		} else if (lang === "go") {
			sourceFile = "program.go";
			fs.writeFileSync(path.join(tempDir, sourceFile), code);
			runStep = { cmd: "go", args: ["run", path.join(tempDir, sourceFile)], timeout: RUN_TIMEOUT_MS };
		} else if (lang === "ruby") {
			sourceFile = "program.rb";
			fs.writeFileSync(path.join(tempDir, sourceFile), code);
			runStep = { cmd: "ruby", args: [path.join(tempDir, sourceFile)], timeout: RUN_TIMEOUT_MS };
		} else if (lang === "php") {
			sourceFile = "program.php";
			fs.writeFileSync(path.join(tempDir, sourceFile), code);
			runStep = { cmd: "php", args: [path.join(tempDir, sourceFile)], timeout: RUN_TIMEOUT_MS };
		} else if (lang === "rust") {
			sourceFile = "program.rs";
			fs.writeFileSync(path.join(tempDir, sourceFile), code);
			compileStep = {
				cmd: "rustc",
				args: [path.join(tempDir, sourceFile), "-o", path.join(tempDir, "program")],
				timeout: COMPILE_TIMEOUT_MS,
			};
			runStep = { cmd: path.join(tempDir, "program"), args: [], timeout: RUN_TIMEOUT_MS };
		} else if (lang === "kotlin") {
			sourceFile = "Program.kt";
			fs.writeFileSync(path.join(tempDir, sourceFile), code);
			compileStep = {
				cmd: "kotlinc",
				args: [
					path.join(tempDir, sourceFile),
					"-include-runtime",
					"-d",
					path.join(tempDir, "Program.jar"),
				],
				timeout: COMPILE_TIMEOUT_MS,
			};
			runStep = {
				cmd: "java",
				args: ["-jar", path.join(tempDir, "Program.jar")],
				timeout: RUN_TIMEOUT_MS,
			};
		} else {
			try {
				fs.rmSync(tempDir, { recursive: true, force: true });
			} catch (e) {}
			return { error: `Unsupported language: ${language}` };
		}
		try {
			if (compileStep) {
				await runProcess(
					compileStep.cmd,
					compileStep.args,
					tempDir,
					null,
					compileStep.timeout,
					MEMORY_LIMIT_KB
				);
			}
			const output = await runProcess(
				runStep.cmd,
				runStep.args,
				tempDir,
				fs.readFileSync(inputPath, "utf8"),
				runStep.timeout,
				MEMORY_LIMIT_KB
			);
			try {
				fs.rmSync(tempDir, { recursive: true, force: true });
			} catch (e) {}
			return { output };
		} catch (err) {
			fs.rmSync(tempDir, { recursive: true, force: true });
			return { errorType: err.type, output: err.output };
		}
	} catch (e) {
		return { errorType: "ServerError", output: e.message };
	}
};

module.exports = { codeCompile };
