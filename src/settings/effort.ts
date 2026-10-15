import type { EffortOption } from '../adapter/ports/channel-view.js'
import type { TuiSettingsFieldOption } from '../adapter/ports/channel-settings.js'
import { SETTING_DEFINITIONS } from './definitions.js'

/** Keep backend IDs verbatim: `off` and `none` are distinct capabilities. */
export function effortDefaultOptions(
  efforts: readonly EffortOption[] | undefined,
  saved: unknown,
): readonly TuiSettingsFieldOption[] {
  const options: TuiSettingsFieldOption[] = [...SETTING_DEFINITIONS.effortDefault.options]
  const seen = new Set(options.map(option => option.value))
  for (const effort of efforts ?? []) {
    if (seen.has(effort.id)) continue
    seen.add(effort.id)
    options.push({ value: effort.id, label: effort.name })
  }
  // A global preference outlives one model's capabilities. Keep it visible
  // and editable until the user chooses another tier or Auto.
  if (typeof saved === 'string' && saved !== '' && !seen.has(saved)) {
    options.push({
      value: saved,
      label: efforts === undefined ? `Saved: ${saved}` : `${saved} (unavailable on this model)`,
      descriptions: { zh: efforts === undefined ? `已保存：${saved}` : `${saved}（当前模型不支持）` },
    })
  }
  return options
}
