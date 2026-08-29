import { describe, expectTypeOf, it } from 'vitest'
import type {
  UserQuestionAnswer,
  UserQuestionInteraction,
  UserQuestionInteractionSnapshot,
} from '../src/index.js'

describe('UserQuestionInteraction contract', () => {
  it('keeps the structured request, answer and cancellation boundary explicit', () => {
    expectTypeOf<keyof UserQuestionInteraction>().toEqualTypeOf<
      'getSnapshot' | 'subscribe' | 'answer' | 'cancel'
    >()
    expectTypeOf<UserQuestionInteractionSnapshot['requests'][number]['questions'][number]['multiSelect']>()
      .toEqualTypeOf<boolean | undefined>()
    expectTypeOf<UserQuestionAnswer['answers'][number]['selected']>()
      .toEqualTypeOf<readonly string[]>()
  })
})
