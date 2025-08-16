import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import React from "react";
import { useSelector } from "react-redux";
import { Command } from "#/state/command-slice";
import { RootState } from "#/store";
import { RUNTIME_INACTIVE_STATES } from "#/types/agent-state";
import { useWsClient } from "#/context/ws-client-provider";
import { getTerminalCommand } from "#/services/terminal-service";
import { parseTerminalOutput } from "#/utils/parse-terminal-output";

/*
  NOTE: Tests for this hook are indirectly covered by the tests for the XTermTerminal component.
  The reason for this is that the hook exposes a ref that requires a DOM element to be rendered.
*/

interface UseTerminalConfig {
  commands: Command[];
}

const DEFAULT_TERMINAL_CONFIG: UseTerminalConfig = {
  commands: [],
};

const renderCommand = (command: Command, terminal: Terminal) => {
  const { content } = command;
  terminal.writeln(
    parseTerminalOutput(content.replaceAll("\n", "\r\n").trim()),
  );
};

// Create a persistent reference that survives component unmounts
// This ensures terminal history is preserved when navigating away and back
const persistentLastCommandIndex = { current: 0 };

const writePrompt = (term: Terminal | null) => {
  if (term) term.write("\x1b[38;2;255;215;0m$\x1b[0m ");
};

// Normalize to avoid fragile dedup (CRLF vs LF, trailing spaces)
const normalizeInput = (s: string) =>
  s.replaceAll("\r\n", "\n").replace(/\s+$/g, "");

// Clear the current line (return to start and erase full line)
const clearCurrentLine = (term: Terminal | null) => {
  if (term) term.write("\r\x1b[2K");
};

export const useTerminal = ({
  commands,
}: UseTerminalConfig = DEFAULT_TERMINAL_CONFIG) => {
  const { send } = useWsClient();
  const { curAgentState } = useSelector((state: RootState) => state.agent);
  const terminal = React.useRef<Terminal | null>(null);
  const fitAddon = React.useRef<FitAddon | null>(null);
  const ref = React.useRef<HTMLDivElement>(null);
  const lastCommandIndex = persistentLastCommandIndex; // Use the persistent reference
  const keyEventDisposable = React.useRef<{ dispose: () => void } | null>(null);
  const disabled = RUNTIME_INACTIVE_STATES.includes(curAgentState);

  // Tracks the last command typed locally to avoid double-echo when it arrives from the stream
  const lastLocalInputRef = React.useRef<string | null>(null);
  // Tracks whether there's an idle prompt already printed ("$ ")
  const hasPendingPromptRef = React.useRef<boolean>(false);
  // Shared buffer for the line being edited (so we can restore after remote events)
  const commandBufferRef = React.useRef<string>("");
  // If a remote event interrupts the local line, restore after the next output
  const restoreOnNextOutputRef = React.useRef<boolean>(false);

  const createTerminal = () =>
    new Terminal({
      fontFamily: "Menlo, Monaco, 'Courier New', monospace",
      fontSize: 14,
      theme: { background: "#24272E" },
    });

  const initializeTerminal = () => {
    if (terminal.current) {
      if (fitAddon.current) terminal.current.loadAddon(fitAddon.current);
      if (ref.current) terminal.current.open(ref.current);
    }
  };

  const copySelection = (selection: string) => {
    const clipboardItem = new ClipboardItem({
      "text/plain": new Blob([selection], { type: "text/plain" }),
    });
    navigator.clipboard.write([clipboardItem]);
  };

  const pasteSelection = (callback: (text: string) => void) => {
    navigator.clipboard.readText().then(callback);
  };

  const pasteHandler = (event: KeyboardEvent, cb: (text: string) => void) => {
    const isControlOrMetaPressed =
      event.type === "keydown" && (event.ctrlKey || event.metaKey);

    if (isControlOrMetaPressed) {
      if (event.code === "KeyV") {
        pasteSelection((text: string) => {
          terminal.current?.write(text);
          cb(text);
        });
      }
      if (event.code === "KeyC") {
        const selection = terminal.current?.getSelection();
        if (selection) copySelection(selection);
      }
    }
    return true;
  };

  const handleEnter = (command: string) => {
    terminal.current?.write("\r\n");
    // Mark last local input (normalized) so we can skip its stream echo
    lastLocalInputRef.current = normalizeInput(command);
    commandBufferRef.current = "";
    send(getTerminalCommand(command));
  };

  const handleBackspace = (command: string) => {
    terminal.current?.write("\b \b");
    return command.slice(0, -1);
  };

  // Initialize terminal and handle cleanup
  React.useEffect(() => {
    terminal.current = createTerminal();
    fitAddon.current = new FitAddon();

    if (ref.current) {
      initializeTerminal();
      // Render all commands in array
      // This happens when we just switch to Terminal from other tabs
      if (commands.length > 0) {
        let lastType: Command["type"] | "" = "";
        for (let i = 0; i < commands.length; i += 1) {
          const c = commands[i];
          lastType = c.type;
          if (c.type === "input") {
            writePrompt(terminal.current);
            renderCommand(c, terminal.current);
          } else {
            // skip empty outputs to avoid extra blank lines on reload
            const text = c.content.replaceAll("\r\n", "\n").trim();
            if (text.length > 0) {
              renderCommand(c, terminal.current);
            }
          }
        }
        lastCommandIndex.current = commands.length;

        // Add a prompt only if the last entry was output (align with live path)
        if (lastType === "output") {
          writePrompt(terminal.current);
          hasPendingPromptRef.current = true;
        } else {
          hasPendingPromptRef.current = false;
        }
      } else {
        // No history: show an initial prompt
        writePrompt(terminal.current);
        hasPendingPromptRef.current = true;
      }
    }

    return () => {
      terminal.current?.dispose();
    };
  }, []);

  React.useEffect(() => {
    if (
      !terminal.current ||
      commands.length === 0 ||
      lastCommandIndex.current >= commands.length
    ) {
      return;
    }

    let lastCommandType: Command["type"] | "" = "";

    for (let i = lastCommandIndex.current; i < commands.length; i += 1) {
      const cmd = commands[i];
      lastCommandType = cmd.type;

      if (cmd.type === "input") {
        // Skip the stream echo of the last locally typed command (normalized)
        const isLocalEcho =
          lastLocalInputRef.current === normalizeInput(cmd.content);

        if (!isLocalEcho) {
          // If the user was typing on this line, clear that line and restore later
          if (!hasPendingPromptRef.current && commandBufferRef.current) {
            clearCurrentLine(terminal.current); // <— cancella "$ ciao"
            restoreOnNextOutputRef.current = true;
          }
          // Ensure we have a prompt for the incoming input
          if (!hasPendingPromptRef.current) {
            writePrompt(terminal.current);
          }
          renderCommand(cmd, terminal.current);
          // Input consumes the prompt
          hasPendingPromptRef.current = false;
        } else {
          // It's our own command; don't render it again
          lastLocalInputRef.current = null;
          hasPendingPromptRef.current = false;
        }
      } else {
        // OUTPUT

        // If user was typing but we didn't clear yet (e.g. output arrives first), clear now
        if (!hasPendingPromptRef.current && commandBufferRef.current) {
          clearCurrentLine(terminal.current); // <— niente doppio newline
          restoreOnNextOutputRef.current = true;
        }

        // If an idle prompt is visible and user NOT typing, clear it so output doesn't start with "$ "
        if (hasPendingPromptRef.current && !commandBufferRef.current) {
          terminal.current.write("\r\x1b[K"); // CR + clear to end
          hasPendingPromptRef.current = false;
        }

        // Skip empty outputs to avoid stray blank lines
        const text = cmd.content.replaceAll("\r\n", "\n").trim();
        if (text.length > 0) {
          renderCommand(cmd, terminal.current);
        }
      }
    }

    lastCommandIndex.current = commands.length;

    // Restore after OUTPUT (single restore point)
    if (lastCommandType === "output") {
      writePrompt(terminal.current);
      if (restoreOnNextOutputRef.current) {
        if (commandBufferRef.current) {
          terminal.current?.write(commandBufferRef.current);
          hasPendingPromptRef.current = false; // keep typing on this line
        } else {
          hasPendingPromptRef.current = true;
        }
        restoreOnNextOutputRef.current = false;
      } else {
        hasPendingPromptRef.current = true;
      }
    }
    // NOTE: deliberately do NOT restore after 'input' only — avoids double prints
  }, [commands, disabled]);

  React.useEffect(() => {
    let resizeObserver: ResizeObserver | null = null;

    resizeObserver = new ResizeObserver(() => {
      fitAddon.current?.fit();
    });

    if (ref.current) {
      resizeObserver.observe(ref.current);
    }

    return () => {
      resizeObserver?.disconnect();
    };
  }, []);

  React.useEffect(() => {
    if (terminal.current) {
      // Dispose of existing listeners if they exist
      if (keyEventDisposable.current) {
        keyEventDisposable.current.dispose();
        keyEventDisposable.current = null;
      }

      // Use shared ref instead of local let, so the buffer survives listener rebinds
      commandBufferRef.current = "";

      if (!disabled) {
        // Add new key event listener and store the disposable
        keyEventDisposable.current = terminal.current.onKey(
          ({ key, domEvent }) => {
            const k = domEvent.key;

            // Block navigation keys so they don't inject escape sequences / move the cursor
            if (
              k === "ArrowUp" ||
              k === "ArrowDown" ||
              k === "ArrowLeft" ||
              k === "ArrowRight" ||
              k === "Home" ||
              k === "End" ||
              k === "PageUp" ||
              k === "PageDown"
            ) {
              domEvent.preventDefault();
              return;
            }

            if (k === "Enter") {
              handleEnter(commandBufferRef.current);
              commandBufferRef.current = "";
              return;
            }

            if (k === "Backspace") {
              if (commandBufferRef.current.length > 0) {
                commandBufferRef.current = handleBackspace(
                  commandBufferRef.current,
                );
                // If buffer becomes empty, we're back to an idle prompt
                if (commandBufferRef.current.length === 0) {
                  hasPendingPromptRef.current = true;
                }
              }
              return;
            }

            // Ignore any ESC-prefixed sequences (e.g., arrows, alt combos)
            if (key.startsWith("\x1b")) {
              domEvent.preventDefault();
              return;
            }

            // Ignore Ctrl/Alt/Meta combos (paste handled by custom handler)
            if (domEvent.ctrlKey || domEvent.altKey || domEvent.metaKey) {
              return;
            }

            // Printable input: append to buffer and echo
            commandBufferRef.current += key;
            terminal.current?.write(key);
            hasPendingPromptRef.current = commandBufferRef.current.length === 0;
          },
        );

        // Add custom key handler and store the disposable
        terminal.current.attachCustomKeyEventHandler((event) =>
          pasteHandler(event, (text) => {
            commandBufferRef.current += text;
            // Paste also consumes the prompt
            if (text.length > 0) hasPendingPromptRef.current = false;
          }),
        );
      } else {
        // Add a noop handler when disabled
        keyEventDisposable.current = terminal.current.onKey((e) => {
          e.domEvent.preventDefault();
          e.domEvent.stopPropagation();
        });
      }
    }

    return () => {
      if (keyEventDisposable.current) {
        keyEventDisposable.current.dispose();
        keyEventDisposable.current = null;
      }
    };
  }, [disabled]);

  return ref;
};
