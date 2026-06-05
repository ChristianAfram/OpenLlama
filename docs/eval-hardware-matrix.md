# Eval Hardware Matrix

The AI eval suite (`npm run eval`) is model-independent and structurally deterministic — it does not require a live model and passes on any hardware that can run Node 18+. This document records:

1. The hardware configurations the eval suite has been tested on.
2. The methodology for performance benchmarks when they exist.
3. The hardware constraints that affect agent quality in live `chat`/`agent` sessions.

---

## 1. Eval suite hardware requirements

The eval suite (`evals/`) runs deterministically: it injects mocked tool calls and fixed responses into the kernel and checks structural guarantees (prompt-injection resistance, destructive-refusal rate, approval-boundary enforcement, etc.). It does **not** call a live model.

**Minimum to run the eval suite:**
- Node.js ≥ 18 (Node 20 LTS used in CI)
- ~256 MB RAM
- Any x86_64 or ARM64 CPU

**CI environment:** GitHub Actions `ubuntu-latest` (x86_64, 2-core, 7 GB RAM). All eval gates pass in this environment.

---

## 2. Tested configurations

| Config | CPU | RAM | GPU | OS | Ollama mode | Result |
|--------|-----|-----|-----|----|-------------|--------|
| CI (GitHub Actions) | x86_64 2-core | 7 GB | None | Ubuntu 22.04 | N/A (eval suite only) | ✅ All gates pass |
| Dev (author) | Ryzen 5 5600X | 16 GB | RX 6650 XT | Windows 11 / WSL2 | CPU fallback (ROCm uneven) | ✅ Tests pass; agent quality bounded by CPU inference speed |

> **Benchmark note:** the author's hardware uses Ollama in CPU-only mode for `qwen2.5-coder:7b` due to uneven ROCm support on the RX 6650 XT. Token throughput is ~8–12 tok/s on CPU for a 7B Q4 model. This is sufficient for development; expect 3–5× faster inference on a machine with working GPU acceleration.

---

## 3. Recommended hardware for live agent sessions

These are guidelines, not hard requirements. The governance kernel runs fine on minimal hardware; what scales with hardware is local model quality and inference speed.

| Use case | Minimum | Recommended |
|----------|---------|-------------|
| Eval suite + unit tests only | Any CPU, 4 GB RAM | Same |
| `chat` / `agent` with 7B model | 8 GB RAM, modern CPU | 16 GB RAM, recent CPU |
| `chat` / `agent` with 13B–14B model | 16 GB RAM | 32 GB RAM or GPU with 8+ GB VRAM |
| `chat` / `agent` with 30B+ model | GPU with 16+ GB VRAM | GPU with 24+ GB VRAM |
| GPU acceleration (NVIDIA) | CUDA 11.8+, 6 GB VRAM | CUDA 12, 8+ GB VRAM |
| GPU acceleration (AMD) | ROCm 5.7+, 8 GB VRAM | ROCm 6, 8+ GB VRAM |
| GPU acceleration (Apple Silicon) | M1 (unified memory) | M2 Pro/Max (18+ GB unified) |

---

## 4. Recommended models

The governance kernel is model-agnostic. Quality and speed vary significantly. Models are registered in `catalog/models.yml`; in `--enterprise` mode only registered models may run.

| Model | Parameters | Primary strength | Recommended hardware |
|-------|-----------|-----------------|---------------------|
| `qwen2.5-coder:7b` | 7B | Strong tool-calling, fast on CPU | 8 GB RAM (CPU), or 6 GB VRAM |
| `qwen2.5-coder:14b` | 14B | Better reasoning, slower | 16 GB RAM or 10 GB VRAM |
| `deepseek-coder-v2:16b` | 16B | Strong at code generation | 16 GB RAM or 12 GB VRAM |
| `llama3.1:8b` | 8B | General capability | 8 GB RAM or 6 GB VRAM |

Default: `qwen2.5-coder:7b`. Override with `--model` or `OPENLLAMA_MODEL`.

**Calibration note from §22 of the master plan:** never publish performance claims that haven't been measured on documented hardware. The numbers above are directional; the author's specific benchmarks are noted in "Tested configurations" above. Do not assert figures you haven't measured.

---

## 5. Benchmark methodology (when measurements are taken)

When a new hardware configuration is tested, record:

1. **Model and quantization:** e.g. `qwen2.5-coder:7b` Q4_K_M.
2. **Inference mode:** CPU / GPU / unified memory.
3. **Token throughput:** tokens/second (prompt eval + generation), measured with `ollama run <model> "hello" --verbose`.
4. **Eval suite runtime:** wall-clock time of `npm run eval` (should be < 60s regardless of hardware since no live model is used).
5. **Agent task benchmark:** time to complete a representative 3-tool-call task (read + propose + write).

Report format:

```
Hardware:  [CPU/GPU description]
OS:        [OS and version]
Model:     [model:tag]
Mode:      [CPU / CUDA / ROCm / Metal]
Throughput: [X tok/s prompt, Y tok/s generation]
Eval suite: [Z seconds]
Agent task: [N seconds for 3-step task]
Date:       [YYYY-MM-DD]
Ollama:     [version]
Node:       [version]
```

---

## 6. Adding a new configuration

To record a new tested configuration, open a PR that adds a row to the "Tested configurations" table above. Include the benchmark data per §5 methodology. Untested configurations should not be listed as "supported."
