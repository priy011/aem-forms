import { subscribe } from '../../rules/index.js';

export default function decorate(fieldDiv, fieldJson, container, formId) {
  const otherOptionLabels = ['other', 'Other'];
  subscribe(fieldDiv, formId, async (element, fieldModel) => {
    const otherInput = fieldDiv.querySelector('.text-wrapper input:last-of-type');
    if (otherInput) {
      otherInput.addEventListener('blur', (e) => {
        // eslint-disable-next-line no-underscore-dangle
        const checkboxField = fieldModel._children.find((child) => child.fieldType === 'checkbox-group');
        if (checkboxField) {
          const otherIndex = checkboxField.enumNames
            .findIndex((name) => otherOptionLabels.includes(name));
          if (otherIndex !== -1) {
            const oldValue = checkboxField.enum[otherIndex];
            checkboxField.enum[otherIndex] = e.target.value;
            const idx = checkboxField.value.indexOf(oldValue);
            if (idx !== -1) {
              checkboxField.value[idx] = e.target.value;
            }
          }
        }
      });

      // Add change listener to the checkbox
      const checkboxField = fieldModel._children.find((child) => child.fieldType === 'checkbox-group');
      if (checkboxField) {
        const otherIndex = checkboxField.enumNames.findIndex((name) => otherOptionLabels.includes(name));
        if (otherIndex !== -1) {
          const otherCheckbox = fieldDiv.querySelector(`input[type="checkbox"][value="${checkboxField.enum[otherIndex]}"]`);
          if (otherCheckbox) {
            otherCheckbox.addEventListener('change', (e) => {
              if (e.target.checked) {
                otherCheckbox.value = otherInput.value;
                checkboxField.enum[otherIndex] = otherInput.value;
              }
            });
          }
        }
      }
    }
  });
}
