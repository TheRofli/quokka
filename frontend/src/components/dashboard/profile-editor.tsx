import { useEffect, useMemo, useState } from "react";
import { CopyPlus, Save, Trash2 } from "lucide-react";

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
  context_size: 8192,
  batch_size: 512,
  ubatch_size: 128,
  temperature: 0.2,
  top_p: 0.95,
  top_k: 40,
  min_p: 0.05,
  cache_prompt: true,
  cache_reuse: 128,
  cache_type_k: "q8_0",
  cache_type_v: "q8_0",
  extra_args: [],
};

export function ProfileEditor({ model, onSave, onDelete, onActivate }: ProfileEditorProps) {
  const active = useMemo(
    () => model.profiles.find((profile) => profile.id === model.active_profile_id) ?? model.profiles[0] ?? blankProfile,
    [model.active_profile_id, model.profiles]
  );
  const [draft, setDraft] = useState<ProfileConfig>(active);
  const [isNew, setIsNew] = useState(false);

  useEffect(() => {
    setDraft(active);
    setIsNew(false);
  }, [active]);

  const setField = <K extends keyof ProfileConfig>(key: K, value: ProfileConfig[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
  };

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
        <Input value={draft.id} onChange={(event) => setField("id", event.target.value)} placeholder="profile-id" />
        <Input value={draft.name} onChange={(event) => setField("name", event.target.value)} placeholder="Display name" />
        <Input
          type="number"
          value={draft.context_size}
          onChange={(event) => setField("context_size", Number(event.target.value))}
          placeholder="Context"
        />
        <Input
          type="number"
          value={draft.batch_size}
          onChange={(event) => setField("batch_size", Number(event.target.value))}
          placeholder="Batch"
        />
        <Input
          type="number"
          value={draft.ubatch_size}
          onChange={(event) => setField("ubatch_size", Number(event.target.value))}
          placeholder="uBatch"
        />
        <Input
          type="number"
          step="0.01"
          value={draft.temperature}
          onChange={(event) => setField("temperature", Number(event.target.value))}
          placeholder="Temperature"
        />
        <Input
          type="number"
          step="0.01"
          value={draft.top_p}
          onChange={(event) => setField("top_p", Number(event.target.value))}
          placeholder="Top P"
        />
        <Input
          type="number"
          value={draft.top_k}
          onChange={(event) => setField("top_k", Number(event.target.value))}
          placeholder="Top K"
        />
        <Input
          type="number"
          step="0.01"
          value={draft.min_p}
          onChange={(event) => setField("min_p", Number(event.target.value))}
          placeholder="Min P"
        />
        <Input
          type="number"
          value={draft.cache_reuse ?? 0}
          onChange={(event) => setField("cache_reuse", Number(event.target.value))}
          placeholder="Cache reuse"
        />
        <Input
          value={draft.cache_type_k ?? ""}
          onChange={(event) => setField("cache_type_k", event.target.value)}
          placeholder="Cache K"
        />
        <Input
          value={draft.cache_type_v ?? ""}
          onChange={(event) => setField("cache_type_v", event.target.value)}
          placeholder="Cache V"
        />
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
