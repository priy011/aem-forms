// Form URL - https://main--aem-boilerplate-forms-ws--adobe-rnd.aem.live/content/aem-forms/customization

// Step 1 - View

import { createOptimizedPicture } from '../../../../scripts/aem.js';
import { subscribe } from '../../rules/index.js';

function createCard(element, fieldJson, enums) {
  // eslint-disable-next-line no-param-reassign
  if (!enums) enums = fieldJson.enumNames.map((e) => ({ ...e, benefits: 'benefits1,benefits2' }));
  element.querySelectorAll('.radio-wrapper').forEach((radioWrapper, index) => {
    if (enums[index]?.name) {
      let label = radioWrapper.querySelector('label');
      if (!label) {
        label = document.createElement('label');
        radioWrapper.appendChild(label);
      }
      label.textContent = enums[index]?.name;
    }
    radioWrapper.querySelector('input').dataset.index = index;
    const image = createOptimizedPicture(enums[index].image || 'https://main--afb--jalagari.hlx.page/lab/images/card.png', 'card-image');
    const benefitsUl = document.createElement('ul');
    benefitsUl.className = 'card-choice-benefits-list';
    const benefits = enums[index]?.benefits?.split(',')?.map((b) => b.trim())?.filter(Boolean);
    benefits?.forEach((benefit) => {
      const li = document.createElement('li');
      li.textContent = benefit;
      benefitsUl.appendChild(li);
    });
    radioWrapper.appendChild(image);
    radioWrapper.appendChild(benefitsUl);
  });
}

//  Decorate
createCard(fieldDiv, fieldJson);
fieldDiv.classList.add('card');

// Step 2 => Model to View Update

subscribe(fieldDiv, formId, (div, fieldModel) => {
  fieldModel.subscribe((e) => {
    const { payload } = e;
    payload?.changes?.forEach((change) => {
      if (change?.propertyName === 'enum') {
        createCard(fieldDiv, fieldJson, change.currentValue);
      }
    });
  });
});

// Step 3 => Value to Model Update

fieldDiv.addEventListener('change', (e) => {
  e.stopPropagation();
  const value = fieldModel.enum?.[parseInt(e.target.dataset.index, 10)];
  fieldModel.value = value?.name;
});
