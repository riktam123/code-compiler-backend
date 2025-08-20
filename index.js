const express = require("express");
const bodyParser = require("body-parser");
const fs = require("fs");
const { exec } = require("child_process");
const path = require("path");
const cors = require("cors");
const { v4: uuidv4 } = require("uuid");

const app = express();

app.use(cors());
app.use(bodyParser.json());

app.post("/run", (req, res) => {
	try {
		const { code, language, input } = req.body;

		if (!code || !language) {
			return res.status(400).json({ error: "Code and language are required" });
		}

		const uniqueId = uuidv4();
		const tempDir = path.join(__dirname, "run", uniqueId);
		fs.mkdirSync(tempDir, { recursive: true });

		let fileName, compileCmd, runCmd;

		switch (language.toLowerCase()) {
			case "c++":
				fileName = "program.cpp";
				compileCmd = `clang++ -std=c++17 ${tempDir}/${fileName} -o ${tempDir}/program`;
				runCmd = `${tempDir}/program`;
				break;
			case "c":
				fileName = "program.c";
				compileCmd = `gcc ${tempDir}/${fileName} -o ${tempDir}/program`;
				runCmd = `${tempDir}/program`;
				break;
			case "python":
			case "python3":
				fileName = "program.py";
				compileCmd = null;
				runCmd = `python3 ${tempDir}/${fileName}`;
				break;
			case "javascript":
			case "js":
				fileName = "program.js";
				compileCmd = null;
				runCmd = `node ${tempDir}/${fileName}`;
				break;
			case "java":
				fileName = "Program.java";
				compileCmd = `javac ${tempDir}/${fileName}`;
				runCmd = `java -cp ${tempDir} Program`;
				break;
			case "csharp":
			case "c#":
				fileName = "Program.cs";
				const csprojFile = `${tempDir}/run.csproj`;
				fs.writeFileSync(
					csprojFile,
					`
								<Project Sdk="Microsoft.NET.Sdk">
								  <PropertyGroup>
									<OutputType>Exe</OutputType>
									<TargetFramework>net8.0</TargetFramework>
								  </PropertyGroup>
								</Project>
							`
				);
				compileCmd = `dotnet build ${tempDir} -o ${tempDir}/out --nologo --verbosity minimal`;
				runCmd = `dotnet ${tempDir}/out/run.dll`;
				break;
			case "typescript":
			case "ts":
				fileName = "program.ts";
				const jsFile = "program.js";
				compileCmd = `npx tsc ${tempDir}/${fileName} --outDir ${tempDir} --esModuleInterop --skipLibCheck`;
				runCmd = `node ${tempDir}/${jsFile}`;
				break;
			case "go":
				fileName = "program.go";
				compileCmd = null;
				runCmd = `go run ${tempDir}/${fileName}`;
				break;
			case "ruby":
				fileName = "program.rb";
				compileCmd = null;
				runCmd = `ruby ${tempDir}/${fileName}`;
				break;
			case "php":
				fileName = "program.php";
				compileCmd = null;
				runCmd = `php ${tempDir}/${fileName}`;
				break;
			case "rust":
				fileName = "program.rs";
				compileCmd = `rustc ${tempDir}/${fileName} -o ${tempDir}/program`;
				runCmd = `${tempDir}/program`;
				break;
			case "kotlin":
				fileName = "Program.kt";
				compileCmd = `kotlinc ${tempDir}/${fileName} -include-runtime -d ${tempDir}/Program.jar`;
				runCmd = `java -jar ${tempDir}/Program.jar`;
				break;
			default:
				return res.status(400).json({ error: `Unsupported language: ${language}` });
		}

		fs.writeFileSync(path.join(tempDir, fileName), code);
		fs.writeFileSync(path.join(tempDir, "input.txt"), input || "");

		const execCommand = compileCmd
			? `${compileCmd} && ${runCmd} < ${tempDir}/input.txt`
			: `${runCmd} < ${tempDir}/input.txt`;

		if (language.toLowerCase() === "typescript" || language.toLowerCase() === "ts") {
			exec(compileCmd, { timeout: 10000 }, (compileErr, compileStdout, compileStderr) => {
				if (compileErr) {
					let errorOutput = compileStderr || compileStdout || compileErr.message;
					errorOutput = [
						...new Set(errorOutput.split("\n").filter((line) => line.includes("error TS"))),
					].join("\n");

					return res.status(500).json({ error: errorOutput.trim() });
				}
				exec(
					`${runCmd} < ${tempDir}/input.txt`,
					{ timeout: 10000 },
					(runErr, runStdout, runStderr) => {
						if (runErr) {
							return res.status(500).json({ error: runStderr || runErr.message });
						}
						res.json({ output: runStdout });
					}
				);
			});
		} else if (language.toLowerCase() === "csharp" || language.toLowerCase() === "c#") {
			exec(compileCmd, { timeout: 10000 }, (compileErr, compileStdout, compileStderr) => {
				if (compileErr) {
					let errorOutput =
						compileStderr + "\n" + compileStdout + "\n" + (compileErr.message || "");
					errorOutput = [
						...new Set(
							errorOutput
								.split("\n")
								.filter((line) => line.includes("error CS") || line.includes("warning CS"))
						),
					];
					errorOutput = errorOutput.join("\n");
					return res.status(500).json({ error: errorOutput.trim() });
				}
				exec(
					`${runCmd} < ${tempDir}/input.txt`,
					{ timeout: 10000 },
					(runErr, runStdout, runStderr) => {
						if (runErr) {
							return res.status(500).json({ error: runStderr || runErr.message });
						}
						res.json({ output: runStdout });
					}
				);
			});
		} else {
			try {
				exec(execCommand, { timeout: 10000 }, (error, stdout, stderr) => {
					try {
						fs.rmSync(tempDir, { recursive: true, force: true });
					} catch (cleanupErr) {
						console.error("Error cleaning up run files:", cleanupErr);
					}

					if (error) {
						console.error("Compiler/Runtime error:", stderr || error.message);
						return res.status(500).json({ error: stderr || error.message });
					}
					res.json({ output: stdout });
				});
			} catch (e) {
				console.log("error", e);
				res.status(500).json({ error: e.message });
			}
		}
	} catch (e) {
		console.log("error", e);
		res.status(500).json({ error: e.message });
	}
});

app.listen(5100, () => console.log("Server running on port 5100"));
