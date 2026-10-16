// SimplenoteWidgets (WidgetBundle: NewNoteWidget, NoteWidget, ListWidget) as a HarmonyOS service widget provider.
// Data is pushed asynchronously with formProvider.updateForm once the store is read (WidgetController).
import { Want } from '@kit.AbilityKit';
import { FormExtensionAbility, formBindingData, formInfo, formProvider } from '@kit.FormKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { WidgetController } from '../common/WidgetController';

export default class WidgetFormAbility extends FormExtensionAbility {
  onAddForm(want: Want): formBindingData.FormBindingData {
    const params: Record<string, Object> = want.parameters ?? {};
    const formId: string = params[formInfo.FormParam.IDENTITY_KEY] as string;
    const formName: string = params[formInfo.FormParam.NAME_KEY] as string;
    const dimension: number = params[formInfo.FormParam.DIMENSION_KEY] as number;
    WidgetController.updateFromExtension(this.context, formId, formName, dimension);
    return formBindingData.createFormBindingData({});
  }

  onUpdateForm(formId: string): void {
    formProvider.getPublishedRunningFormInfoById(formId).then((info: formInfo.RunningFormInfo) => {
      WidgetController.updateFromExtension(this.context, formId, info.formName, info.dimension);
    }).catch((e: BusinessError) => {
      console.error(`WidgetFormAbility onUpdateForm ${formId}: ${e.code} ${e.message}`);
    });
  }

  onRemoveForm(formId: string): void {
    WidgetController.forget(this.context, formId);
  }
}
