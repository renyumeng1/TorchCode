# TorchCode Practice for VS Code

Use the TorchCode problem set directly in VS Code. The extension provides a
sidebar for progress, problem navigation, the active notebook's introduction,
hints, and structured judge results.

## Development

From this directory:

```powershell
npm install
npm run compile
```

Open this folder in VS Code and press `F5` to launch an Extension Development
Host. Open the TorchCode repository in that window, then select the TorchCode
icon in the Activity Bar.

## Build a VSIX

```powershell
npm install
npm run package
```

Install the generated `.vsix` with VS Code's `Extensions: Install from VSIX...`
command.

## Requirements

- The TorchCode repository is open as a VS Code workspace.
- A Python interpreter with `torch` available. The extension prefers
  `.venv/Scripts/python.exe` on Windows when it exists.
- The Microsoft Jupyter extension is recommended for editing `.ipynb` files.

Set `torchcode.workspaceRoot` or `torchcode.pythonPath` when the repository or
interpreter cannot be discovered automatically.
