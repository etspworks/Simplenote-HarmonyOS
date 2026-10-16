// SimplenoteIntents NoteWidgetIntentHandler / ListWidgetIntentHandler (iOS "Edit Widget" > Note / Tag) as the
// FormKit widget editor: the launcher opens it from the placed widget (form_config.json formConfigAbility).
import { UIExtensionContentSession, Want } from '@kit.AbilityKit';
import { FormEditExtensionAbility, formInfo } from '@kit.FormKit';
import { hilog } from '@kit.PerformanceAnalysisKit';

export default class WidgetEditAbility extends FormEditExtensionAbility {
  onSessionCreate(want: Want, session: UIExtensionContentSession): void {
    const params: Record<string, Object> = want.parameters ?? {};
    hilog.info(0x0001, 'WidgetEditAbility', 'want %{public}s', JSON.stringify(params));
    const storage: Record<string, Object> = {
      'session': session,
      'context': this.context,
      // The launcher passes the placed widget's id as 'cardId'.
      'formId': String(params['cardId'] ?? params[formInfo.FormParam.IDENTITY_KEY] ?? ''),
      // The editor sheet's own preview of the widget (above the picker).
      'previewFormId': String(params['previewCardId'] ?? '')
    };
    session.loadContent('pages/WidgetEditPage', new LocalStorage(storage));
  }
}
