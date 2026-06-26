<script lang="ts">
  import { getLang, setLang, t } from '../i18n/index.svelte';

  function selectEn() {
    setLang('en');
  }

  function selectHe() {
    setLang('he');
  }
</script>

<fieldset
  class="ms-auto inline-flex items-center gap-2 rounded-md border border-gray-300 px-3 py-1.5 text-sm"
  aria-label={t('language.toggle')}
>
  <legend class="sr-only">{t('language.toggle')}</legend>

  <label class="cursor-pointer">
    <input
      type="radio"
      name="lang"
      value="en"
      class="sr-only"
      checked={getLang() === 'en'}
      onchange={selectEn}
    />
    <span class={getLang() === 'en' ? 'font-semibold text-brand-700' : 'text-gray-600'}>
      {t('language.en')}
    </span>
  </label>

  <span aria-hidden="true" class="text-gray-300">·</span>

  <label class="cursor-pointer">
    <input
      type="radio"
      name="lang"
      value="he"
      class="sr-only"
      checked={getLang() === 'he'}
      onchange={selectHe}
    />
    <span class={getLang() === 'he' ? 'font-semibold text-brand-700' : 'text-gray-600'}>
      {t('language.he')}
    </span>
  </label>
</fieldset>
