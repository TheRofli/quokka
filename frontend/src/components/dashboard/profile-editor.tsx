import { useEffect, useMemo, useState, type ReactNode } from "react";
import { CopyPlus, FileInput, Save, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ModelView, ProfileConfig } from "@/types/api";

interface ProfileEditorProps {
  model: ModelView;
  onSave: (modelId: string, profile: ProfileConfig, isNew: boolean) => Promise<void>;
  onDelete: (modelId: string, profileId: string) => Promise<void>;
  onActivate: (modelId: string, profileId: string) => Promise<void>;
}

const blankProfile: ProfileConfig = {
  id: "",
  name: "",
  model_path: null,
  context_size: 8192,
  batch_size: 512,
  ubatch_size: 128,
  n_gpu_layers: 999,
  parallel: 1,
  cache_ram: 0,
  repeat_penalty: null,
  threads: null,
  threads_batch: null,
  api_default_completion_max_tokens: 2048,
  temperature: 0.2,
  top_p: 0.95,
  top_k: 40,
  min_p: 0.05,
  cache_prompt: true,
  cache_reuse: 128,
  cache_type_k: "q8_0",
  cache_type_v: "q8_0",
  flash_attn: true,
  jinja: true,
  no_mmap: true,
  mlock: false,
  override_tensor: null,
  reasoning_format: null,
  extra_args: [],
};

const fieldHelp: Record<string, string> = {
  id: "Stable internal profile id. Keep it short and unique.",
  name: "Human readable profile name shown in Quokka.",
  model_path: "GGUF path inside WSL, for example ~/llm/models/qwen3/Qwen3-Q5_K_XL.gguf.",
  context_size: "Context window. Higher values allow longer chats but consume more KV-cache memory.",
  batch_size: "Prompt processing batch. Higher can improve ingestion speed but uses more memory.",
  ubatch_size: "Micro-batch size. Lower values reduce VRAM spikes, higher values can improve throughput.",
  n_gpu_layers: "llama.cpp --n-gpu-layers. 999 tries to keep all layers on GPU. Lower values save VRAM but usually slow generation.",
  parallel: "llama.cpp --parallel. Number of request slots. More slots raise memory use and can reduce single-user speed.",
  cache_ram: "llama.cpp --cache-ram. Prompt cache RAM budget in MB. 0 disables the new prompt cache.",
  repeat_penalty: "llama.cpp --repeat-penalty. Mildly reduces repeated text. Leave empty for server default.",
  threads: "llama.cpp --threads. CPU worker threads, important when experts or layers are offloaded to CPU.",
  threads_batch: "llama.cpp --threads-batch. CPU threads used for prompt processing.",
  api_default_completion_max_tokens: "llama.cpp --api-default-completion-max-tokens. Default cap if a client forgets max_tokens.",
  temperature: "Sampling randomness. Lower is more deterministic, higher is more creative.",
  top_p: "Nucleus sampling limit. 0.9-0.95 is a common local model range.",
  top_k: "Token candidate cap. Lower values can make output more focused.",
  min_p: "Minimum probability filter. Useful for modern llama.cpp sampling.",
  cache_reuse: "Prompt cache reuse amount. Leave 0/null when prompt cache is disabled.",
  cache_type_k: "KV cache K quantization. q4_0 saves VRAM, q8_0 keeps more precision.",
  cache_type_v: "KV cache V quantization. q4_0 saves VRAM, q8_0 keeps more precision.",
  flash_attn: "llama.cpp --flash-attn on/off. Usually faster and saves memory on supported GPUs.",
  jinja: "llama.cpp --jinja. Enables tokenizer chat templates that require Jinja.",
  no_mmap: "llama.cpp --no-mmap. Loads model into memory instead of memory-mapping the file.",
  mlock: "llama.cpp --mlock. Tries to keep model pages in RAM and avoid paging.",
  override_tensor: 'Advanced llama.cpp --override-tensor value, for example "\\.ffn_.*_exps\\.weight=CPU" for MoE expert offload.',
  reasoning_format: "llama.cpp --reasoning-format. Example: deepseek. Use only when the model/server build supports it.",
  extra_args: "Additional llama-server flags that Quokka does not expose as dedicated controls yet.",
};

function readFlag(command: string, flag: string) {
  const match = command.match(new RegExp(`${flag.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}\\s+([^\\s\\\\]+)`));
  return match?.[1]?.replace(/^["']|["']$/g, "");
}

function hasFlag(command: string, flag: string) {
  return new RegExp(`${flag.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}(\\s|$)`).test(command);
}

function upsertArg(args: string[], flag: string, value: string) {
  const next = [...args];
  const index = next.indexOf(flag);
  if (index >= 0) {
    next[index + 1] = value;
    return next;
  }
  next.push(flag, value);
  return next;
}

const importedValueFlags = new Set([
  "--ctx-size",
  "--batch-size",
  "--ubatch-size",
  "--temp",
  "--top-p",
  "--top-k",
  "--min-p",
  "--cache-type-k",
  "--cache-type-v",
  "--n-gpu-layers",
  "--parallel",
  "--cache-ram",
  "--repeat-penalty",
  "--threads",
  "--threads-batch",
  "--api-default-completion-max-tokens",
  "--flash-attn",
  "--override-tensor",
  "--reasoning-format",
]);
const importedBooleanFlags = new Set(["--jinja", "--no-mmap", "--mlock"]);

function withoutImportedManagedArgs(args: string[]) {
  const next: string[] = [];
  let skipNext = false;
  for (const item of args) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (importedValueFlags.has(item)) {
      skipNext = true;
      continue;
    }
    if (importedBooleanFlags.has(item)) {
      continue;
    }
    next.push(item);
  }
  return next;
}

export function ProfileEditor({ model, onSave, onDelete, onActivate }: ProfileEditorProps) {
  const active = useMemo(
    () => model.profiles.find((profile) => profile.id === model.active_profile_id) ?? model.profiles[0] ?? blankProfile,
    [model.active_profile_id, model.profiles]
  );
  const [draft, setDraft] = useState<ProfileConfig>(active);
  const [isNew, setIsNew] = useState(false);
  const [importText, setImportText] = useState("");

  useEffect(() => {
    setDraft(active);
    setIsNew(false);
  }, [model.id, active.id]);

  const setField = <K extends keyof ProfileConfig>(key: K, value: ProfileConfig[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
  };

  const applyImportedCommand = () => {
    const command = importText.replace(/\\\r?\n/g, " ").replace(/\r?\n/g, " ");
    const imported: Partial<ProfileConfig> = {};
    const numericFields: Array<[keyof ProfileConfig, string, (value: string) => number]> = [
      ["context_size", "--ctx-size", Number],
      ["batch_size", "--batch-size", Number],
      ["ubatch_size", "--ubatch-size", Number],
      ["temperature", "--temp", Number],
      ["top_p", "--top-p", Number],
      ["top_k", "--top-k", Number],
      ["min_p", "--min-p", Number],
      ["cache_reuse", "--cache-reuse", Number],
      ["n_gpu_layers", "--n-gpu-layers", Number],
      ["parallel", "--parallel", Number],
      ["cache_ram", "--cache-ram", Number],
      ["repeat_penalty", "--repeat-penalty", Number],
      ["threads", "--threads", Number],
      ["threads_batch", "--threads-batch", Number],
      ["api_default_completion_max_tokens", "--api-default-completion-max-tokens", Number],
    ];
    for (const [key, flag, cast] of numericFields) {
      const value = readFlag(command, flag);
      if (value !== undefined) {
        imported[key] = cast(value) as never;
      }
    }

    const modelPath = readFlag(command, "-m");
    const cacheTypeK = readFlag(command, "--cache-type-k");
    const cacheTypeV = readFlag(command, "--cache-type-v");
    const flashAttn = readFlag(command, "--flash-attn");
    const overrideTensor = readFlag(command, "--override-tensor");
    const reasoningFormat = readFlag(command, "--reasoning-format");
    const reasoning = readFlag(command, "--reasoning");
    imported.model_path = modelPath ?? draft.model_path;
    imported.cache_type_k = cacheTypeK ?? draft.cache_type_k;
    imported.cache_type_v = cacheTypeV ?? draft.cache_type_v;
    imported.cache_prompt = hasFlag(command, "--prompt-cache-all");
    imported.flash_attn = flashAttn ? flashAttn !== "off" : draft.flash_attn;
    imported.jinja = hasFlag(command, "--jinja");
    imported.no_mmap = hasFlag(command, "--no-mmap");
    imported.mlock = hasFlag(command, "--mlock");
    imported.override_tensor = overrideTensor ?? draft.override_tensor;
    imported.reasoning_format = reasoningFormat ?? draft.reasoning_format;

    let extraArgs = withoutImportedManagedArgs(draft.extra_args);
    if (reasoning) extraArgs = upsertArg(extraArgs, "--reasoning", reasoning);

    setDraft((current) => ({ ...current, ...imported, extra_args: extraArgs }));
    setImportText("");
  };

  const importFile = async (file: File | undefined) => {
    if (!file) {
      return;
    }
    setImportText(await file.text());
  };

  const input = (
    key: keyof ProfileConfig,
    label: string,
    inputNode: ReactNode,
  ) => (
    <label className="space-y-1" title={fieldHelp[String(key)]}>
      <span className="block text-[11px] uppercase tracking-[0.18em] text-milk/35">{label}</span>
      {inputNode}
    </label>
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        {model.profiles.map((profile) => (
          <Button
            key={profile.id}
            variant={profile.id === draft.id && !isNew ? "primary" : "secondary"}
            size="sm"
            onClick={() => {
              setDraft(profile);
              setIsNew(false);
            }}
          >
            {profile.name}
          </Button>
        ))}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setDraft({ ...blankProfile, id: `${model.id}-custom`, name: "Custom Profile" });
            setIsNew(true);
          }}
        >
          <CopyPlus className="h-4 w-4" />
          New
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-3">
        {input("id", "Profile ID", <Input value={draft.id} onChange={(event) => setField("id", event.target.value)} />)}
        {input("name", "Display Name", <Input value={draft.name} onChange={(event) => setField("name", event.target.value)} />)}
        <div className="col-span-2">
          {input("model_path", "Model file", <Input value={draft.model_path ?? ""} onChange={(event) => setField("model_path", event.target.value || null)} placeholder="~/llm/models/...gguf" />)}
        </div>
        {input("context_size", "Context", <Input type="number" value={draft.context_size} onChange={(event) => setField("context_size", Number(event.target.value))} />)}
        {input("batch_size", "Batch", <Input type="number" value={draft.batch_size} onChange={(event) => setField("batch_size", Number(event.target.value))} />)}
        {input("ubatch_size", "uBatch", <Input type="number" value={draft.ubatch_size} onChange={(event) => setField("ubatch_size", Number(event.target.value))} />)}
        {input("temperature", "Temperature", <Input type="number" step="0.01" value={draft.temperature} onChange={(event) => setField("temperature", Number(event.target.value))} />)}
        {input("top_p", "Top P", <Input type="number" step="0.01" value={draft.top_p} onChange={(event) => setField("top_p", Number(event.target.value))} />)}
        {input("top_k", "Top K", <Input type="number" value={draft.top_k} onChange={(event) => setField("top_k", Number(event.target.value))} />)}
        {input("min_p", "Min P", <Input type="number" step="0.01" value={draft.min_p} onChange={(event) => setField("min_p", Number(event.target.value))} />)}
        {input("cache_reuse", "Cache Reuse", <Input type="number" value={draft.cache_reuse ?? 0} onChange={(event) => setField("cache_reuse", Number(event.target.value))} />)}
        {input("cache_type_k", "Cache K", <Input value={draft.cache_type_k ?? ""} onChange={(event) => setField("cache_type_k", event.target.value || null)} />)}
        {input("cache_type_v", "Cache V", <Input value={draft.cache_type_v ?? ""} onChange={(event) => setField("cache_type_v", event.target.value || null)} />)}
        {input("n_gpu_layers", "n-gpu-layers", <Input type="number" value={draft.n_gpu_layers ?? ""} onChange={(event) => setField("n_gpu_layers", event.target.value ? Number(event.target.value) : null)} />)}
        {input("parallel", "Parallel", <Input type="number" value={draft.parallel ?? ""} onChange={(event) => setField("parallel", event.target.value ? Number(event.target.value) : null)} />)}
        {input("cache_ram", "Cache RAM", <Input type="number" value={draft.cache_ram ?? ""} onChange={(event) => setField("cache_ram", event.target.value ? Number(event.target.value) : null)} />)}
        {input("repeat_penalty", "Repeat Penalty", <Input type="number" step="0.01" value={draft.repeat_penalty ?? ""} onChange={(event) => setField("repeat_penalty", event.target.value ? Number(event.target.value) : null)} />)}
        {input("threads", "Threads", <Input type="number" value={draft.threads ?? ""} onChange={(event) => setField("threads", event.target.value ? Number(event.target.value) : null)} />)}
        {input("threads_batch", "Threads Batch", <Input type="number" value={draft.threads_batch ?? ""} onChange={(event) => setField("threads_batch", event.target.value ? Number(event.target.value) : null)} />)}
        <div className="col-span-2">
          {input(
            "api_default_completion_max_tokens",
            "API default max tokens",
            <Input
              type="number"
              value={draft.api_default_completion_max_tokens ?? ""}
              onChange={(event) => setField("api_default_completion_max_tokens", event.target.value ? Number(event.target.value) : null)}
            />
          )}
        </div>
        <div className="col-span-2 grid gap-2 rounded-lg border border-line bg-white/[0.025] p-3 sm:grid-cols-2">
          {([
            ["flash_attn", "Flash attention"],
            ["jinja", "Jinja templates"],
            ["no_mmap", "No mmap"],
            ["mlock", "Mlock"],
          ] as const).map(([key, label]) => (
            <label key={key} className="flex items-center gap-2 text-sm text-milk/72" title={fieldHelp[key]}>
              <input
                type="checkbox"
                checked={Boolean(draft[key])}
                onChange={(event) => setField(key, event.target.checked as never)}
                className="h-4 w-4 accent-[#b08b66]"
              />
              {label}
            </label>
          ))}
        </div>
        <div className="col-span-2">
          {input("override_tensor", "Override tensor", <Input value={draft.override_tensor ?? ""} onChange={(event) => setField("override_tensor", event.target.value || null)} placeholder={'\\.ffn_.*_exps\\.weight=CPU'} />)}
        </div>
        <div className="col-span-2">
          {input("reasoning_format", "Reasoning format", <Input value={draft.reasoning_format ?? ""} onChange={(event) => setField("reasoning_format", event.target.value || null)} placeholder="deepseek" />)}
        </div>
        <label className="col-span-2 flex items-center gap-2 rounded-lg border border-line bg-white/[0.03] px-3 py-2 text-sm text-milk/72">
          <input
            type="checkbox"
            checked={draft.cache_prompt}
            onChange={(event) => setField("cache_prompt", event.target.checked)}
            className="h-4 w-4 accent-[#b08b66]"
          />
          Enable prompt cache
        </label>
        <div className="col-span-2">
          <Input
            value={draft.extra_args.join(" ")}
            onChange={(event) =>
              setField(
                "extra_args",
                event.target.value
                  .split(" ")
                  .map((item) => item.trim())
                  .filter(Boolean)
              )
            }
            placeholder="Extra args"
          />
        </div>
        <div className="col-span-2 space-y-2 rounded-lg border border-line bg-white/[0.025] p-3">
          <p className="text-[11px] uppercase tracking-[0.18em] text-milk/35">Import launch text or .bat content</p>
          <Input
            type="file"
            accept=".bat,.cmd,.sh,.txt"
            onChange={(event) => {
              void importFile(event.target.files?.[0]);
              event.target.value = "";
            }}
          />
          <textarea
            value={importText}
            onChange={(event) => setImportText(event.target.value)}
            className="min-h-28 w-full rounded-lg border border-line bg-black/20 px-3 py-2 text-sm text-milk outline-none placeholder:text-milk/30 focus:border-accent/60"
            placeholder="Paste a llama-server command or .bat file content here."
          />
          <Button variant="secondary" size="sm" disabled={!importText.trim()} onClick={applyImportedCommand}>
            <FileInput className="h-4 w-4" />
            Import into profile
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button variant="primary" size="sm" onClick={() => onSave(model.id, draft, isNew)}>
          <Save className="h-4 w-4" />
          Save
        </Button>
        <Button variant="secondary" size="sm" onClick={() => onActivate(model.id, draft.id)}>
          Activate
        </Button>
        {!isNew ? (
          <Button variant="danger" size="sm" onClick={() => onDelete(model.id, draft.id)}>
            <Trash2 className="h-4 w-4" />
            Delete
          </Button>
        ) : null}
      </div>
    </div>
  );
}
