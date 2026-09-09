/**
 * Custom-field payload shaping for the workbench forms.
 *
 * The edit form keeps one state object per entity: stored values as-is, with
 * `null` marking an optional field the user cleared and `false` a real
 * boolean value. Creation never sends `null` for a blank optional field — it
 * omits the key instead, because there is nothing to clear on a new record.
 */

export const isBlankCustomFieldValue = (value: unknown): boolean =>
  value === undefined || value === null || value === '';

export const customFieldsForCreate = (
  values: Record<string, unknown>,
): Record<string, unknown> | undefined => {
  const entries = Object.entries(values).filter(([, value]) => value !== null);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
};

/**
 * Update payloads are PATCH-like, so cleared optional fields must reach the
 * API as explicit `null` and boolean `false` must stay a real value.
 */
export const customFieldsForUpdate = (
  values: Record<string, unknown>,
  activeDefinitions: ReadonlyArray<{ key: string }>,
): Record<string, unknown> | undefined => {
  const activeKeys = new Set(activeDefinitions.map((field) => field.key));
  const entries = Object.entries(values).filter(([key]) => activeKeys.has(key));
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
};
