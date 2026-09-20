/** The General section: one column rendering feature-owned item contributions. */
import type { PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './GeneralSection.module.css'

/** Full component props: section owner share plus item render share. */
export type GeneralSectionComponentProps =
  PropsRuntime<'settings.section'> & PropsRenderSlots<'settings.general.item'> & {
    useItemIds?: <R>(selector: (ids: readonly string[] | undefined) => R) => R
  }

/**
 * Render the General section content column.
 * @param props - composed slot props (contract/slots.ts).
 * @returns the section element tree.
 */
export function GeneralSection({ renderSlot, useItemIds }: GeneralSectionComponentProps) {
  const ids = useItemIds?.(value => value)
  return (
    <div className={css.section}>
      {ids === undefined ? renderSlot('settings.general.item', {})
        : ids.map(id => <div key={id}>{renderSlot('settings.general.item', {}, { only: id })}</div>)}
    </div>
  )
}
