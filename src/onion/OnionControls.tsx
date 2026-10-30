import { MAX_ONION_FRAMES, type OnionSettings } from "./onion";

export interface OnionControlsProps {
   settings: OnionSettings;
   onChange: (settings: OnionSettings) => void;
}

/** Toggle and tune onion-skinning. */
export function OnionControls({ settings, onChange }: OnionControlsProps) {
   function set<K extends keyof OnionSettings>(
      key: K,
      value: OnionSettings[K],
   ) {
      onChange({ ...settings, [key]: value });
   }
   return (
      <fieldset className="onion-controls">
         <label>
            <input
               type="checkbox"
               checked={settings.enabled}
               onChange={(event) => set("enabled", event.target.checked)}
            />
            Onion skin (O)
         </label>
         <label>
            Before
            <input
               type="number"
               min={0}
               max={MAX_ONION_FRAMES}
               value={settings.before}
               disabled={!settings.enabled}
               onChange={(event) =>
                  set("before", event.target.valueAsNumber || 0)
               }
            />
         </label>
         <label>
            After
            <input
               type="number"
               min={0}
               max={MAX_ONION_FRAMES}
               value={settings.after}
               disabled={!settings.enabled}
               onChange={(event) =>
                  set("after", event.target.valueAsNumber || 0)
               }
            />
         </label>
         <label>
            Opacity
            <input
               type="range"
               min={0}
               max={1}
               step={0.05}
               value={settings.opacity}
               disabled={!settings.enabled}
               onChange={(event) => set("opacity", event.target.valueAsNumber)}
            />
         </label>
         <label>
            Falloff
            <input
               type="range"
               min={0}
               max={1}
               step={0.05}
               value={settings.falloff}
               disabled={!settings.enabled}
               onChange={(event) => set("falloff", event.target.valueAsNumber)}
            />
         </label>
         <label>
            <input
               type="checkbox"
               checked={settings.tint}
               disabled={!settings.enabled}
               onChange={(event) => set("tint", event.target.checked)}
            />
            Tint (red before, cyan after)
         </label>
      </fieldset>
   );
}
