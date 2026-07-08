/* Intake view (spec 6.1) — the assistance request form.
 *
 * Collects a household's contact info, goods requests, social-service
 * requests, and delivery address, then POSTs it to /intake/submissions.
 * The API normalizes request types (catalog keys OR any language segment of
 * a trilingual label), finds-or-creates the household, and creates
 * deduplicated Open requests. We render the returned IntakeResult so the
 * operator sees whether a household was created or matched, which requests
 * were opened, and any duplicates / unknown types / phone problems.
 *
 * Mirrors views/checkin.js for structure, error handling, and loading state. */

(function () {
  "use strict";

  const { h, clear, toast, api } = window.BAM;

  // Common goods offered as one-tap chips. Values are catalog keys; the API
  // also accepts free-text label segments (see the "add another" field).
  const COMMON_GOODS = [
    { key: "groceries", label: "Groceries" },
    { key: "soap", label: "Soap & Shower" },
    { key: "pots_pans", label: "Pots & Pans" },
    { key: "baby_diapers", label: "Baby Diapers" },
    { key: "school_supplies", label: "School Supplies" },
    { key: "clothing", label: "Clothing" },
    { key: "sofa", label: "Sofa" },
    { key: "bed", label: "Bed" },
    { key: "crib", label: "Crib" },
    { key: "other_furniture", label: "Other Furniture" },
  ];

  // Goods keys that reveal the furniture-details card (bed details +
  // acknowledgement + delivery address emphasis, spec 6.1).
  const FURNITURE_HINT = /bed|mattress|sofa|crib|furniture|dresser|desk|table|chairs|storage|refrigerator|fridge|conditioner/i;

  // All 12 social services (spec 4: "Service type (12 options)"), catalog keys.
  const SOCIAL_SERVICES = [
    { key: "housing", label: "Securing housing" },
    { key: "health_insurance", label: "Medical insurance support" },
    { key: "tenant_legal", label: "Tenant legal assistance" },
    { key: "in_school_services", label: "In-school services" },
    { key: "tutoring", label: "Tutoring for students" },
    { key: "english_classes", label: "English classes" },
    { key: "business_support", label: "Small business support" },
    { key: "food_benefits", label: "Food benefits (WIC / SNAP / P-EBT)" },
    { key: "transportation", label: "Transportation assistance" },
    { key: "child_disability", label: "Assistance for disabled children" },
    { key: "pet_assistance", label: "Pet assistance" },
    { key: "internet", label: "Low-cost home internet" },
  ];

  // Shared language vocabulary (BAM.LANGUAGES, app.js) — the same verbatim
  // strings the outreach filters use, so exact-string matching works.
  const COMMON_LANGUAGES = window.BAM.LANGUAGES;

  // Internet-access options mirror the production form; only shown when the
  // "internet" social service is selected. Free-form on the server; we send
  // the selected label strings.
  const INTERNET_ACCESS_OPTIONS = [
    "No internet at home",
    "Slow or unreliable internet",
    "Uses phone data only",
    "Has home internet",
  ];

  // Friendly display names for the catalog keys the API may echo back in
  // skipped_duplicate_types (which returns keys, not labels).
  const KEY_LABELS = {};
  COMMON_GOODS.forEach((g) => (KEY_LABELS[g.key] = g.label));
  SOCIAL_SERVICES.forEach((s) => (KEY_LABELS[s.key] = s.label));
  function prettyType(value) {
    if (KEY_LABELS[value]) return KEY_LABELS[value];
    // Turn "baby_diapers" -> "Baby diapers"; leave labels/free text as-is.
    if (/^[a-z0-9_]+$/.test(value)) {
      const s = value.replace(/_/g, " ");
      return s.charAt(0).toUpperCase() + s.slice(1);
    }
    return value;
  }

  function render(container) {
    // ---- view state ------------------------------------------------------
    const state = { submitting: false };

    // Selected goods request types (catalog keys or free-text label segments).
    const selectedGoods = new Set();
    // Extra free-text goods the operator typed, in insertion order for chips.
    const customGoods = [];
    // Extra free-text languages the operator typed.
    const customLanguages = [];

    const heading = h(
      "div",
      { class: "view-heading" },
      h("h1", {}, "Intake"),
      h(
        "p",
        { class: "muted" },
        "Record a household's assistance request. Only a phone number is required."
      )
    );

    // ---- contact card ----------------------------------------------------
    const phoneInput = h("input", {
      class: "input",
      id: "intake-phone",
      name: "phone",
      type: "tel",
      inputmode: "tel",
      autocomplete: "off",
      required: true,
      placeholder: "(718) 555-0142",
    });
    const nameInput = h("input", {
      class: "input",
      id: "intake-name",
      name: "name",
      type: "text",
      autocomplete: "off",
      placeholder: "First name (optional)",
    });
    const emailInput = h("input", {
      class: "input",
      id: "intake-email",
      name: "email",
      type: "email",
      inputmode: "email",
      autocomplete: "off",
      placeholder: "name@example.com (optional)",
    });

    const contactCard = h(
      "div",
      { class: "card stack" },
      h("h2", { class: "card__title" }, "Contact"),
      field("intake-phone", "Phone number", phoneInput, "Required."),
      field("intake-name", "Name", nameInput),
      field("intake-email", "Email", emailInput)
    );

    // ---- languages card --------------------------------------------------
    const languageBoxes = COMMON_LANGUAGES.map((lang) =>
      checkboxRow(`lang-${slug(lang)}`, lang)
    );
    const languageChips = h("div", { class: "row", id: "intake-language-chips" });

    const languageAddInput = h("input", {
      class: "input",
      type: "text",
      id: "intake-language-add",
      autocomplete: "off",
      placeholder: "Add another language",
      "aria-label": "Add another language",
      onkeydown: (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          addCustomLanguage();
        }
      },
    });
    const languageAddBtn = h(
      "button",
      { class: "btn", type: "button", onclick: addCustomLanguage },
      "Add"
    );

    const languagesCard = h(
      "div",
      { class: "card stack" },
      h("h2", { class: "card__title" }, "Languages"),
      h("div", { class: "stack" }, languageBoxes),
      languageChips,
      h(
        "div",
        { class: "field" },
        h("label", { class: "label", for: "intake-language-add" }, "Other language"),
        h("div", { class: "row" }, h("div", { class: "grow" }, languageAddInput), languageAddBtn)
      )
    );

    // ---- goods card ------------------------------------------------------
    const goodsChips = h("div", { class: "row", id: "intake-goods-chips" });

    const goodsAddInput = h("input", {
      class: "input",
      type: "text",
      id: "intake-goods-add",
      autocomplete: "off",
      placeholder: "e.g. Microwave, or a full trilingual label",
      "aria-label": "Add another requested item",
      onkeydown: (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          addCustomGood();
        }
      },
    });
    const goodsAddBtn = h(
      "button",
      { class: "btn", type: "button", onclick: addCustomGood },
      "Add"
    );

    const goodsCard = h(
      "div",
      { class: "card stack" },
      h("h2", { class: "card__title" }, "Requested items"),
      h(
        "p",
        { class: "muted", style: { margin: "0" } },
        "Tap the goods this household needs. Add anything else by name."
      ),
      goodsChips,
      h(
        "div",
        { class: "field" },
        h("label", { class: "label", for: "intake-goods-add" }, "Add another item"),
        h("div", { class: "row" }, h("div", { class: "grow" }, goodsAddInput), goodsAddBtn)
      )
    );

    // ---- furniture details card (spec 6.1: Bed Details + Furniture
    // Acknowledgement) — visible only when a furniture-ish good is selected.
    const bedDetailsInput = h("input", {
      class: "input",
      id: "intake-bed-details",
      name: "bed_details",
      type: "text",
      autocomplete: "off",
      placeholder: "e.g. Queen mattress + frame",
    });
    const furnitureAckBox = checkboxRow(
      "intake-furniture-ack",
      "Household understands furniture terms (pickup/delivery arrangements)",
      { value: "ack" }
    );
    const furniturePanel = h(
      "div",
      { class: "card stack", id: "intake-furniture-panel", hidden: true, style: { display: "none" } },
      h("h3", { class: "card__title", style: { fontSize: "14px" } }, "Furniture details"),
      field(
        "intake-bed-details",
        "Bed details (size, mattress/frame)",
        bedDetailsInput,
        "Stored with the bed/furniture request."
      ),
      furnitureAckBox,
      h(
        "p",
        { class: "muted", style: { margin: "0" } },
        "Remember the delivery address below — furniture requests need it."
      )
    );

    function furnitureSelected() {
      return [...selectedGoods].some((value) => FURNITURE_HINT.test(value));
    }

    function syncFurniturePanel() {
      const on = furnitureSelected();
      furniturePanel.hidden = !on;
      furniturePanel.style.display = on ? "" : "none";
    }

    // ---- social services card -------------------------------------------
    const serviceBoxes = SOCIAL_SERVICES.map((svc) =>
      checkboxRow(`svc-${svc.key}`, svc.label, {
        value: svc.key,
        onchange: svc.key === "internet" ? syncInternetPanel : undefined,
      })
    );

    // Internet-access sub-panel: only visible when the "internet" service is
    // checked (spec 6.1: internet_access + roof_accessible for internet).
    const internetAccessBoxes = INTERNET_ACCESS_OPTIONS.map((opt) =>
      checkboxRow(`net-${slug(opt)}`, opt, { value: opt })
    );
    const roofBox = checkboxRow("intake-roof", "Roof is accessible for an install", {
      value: "roof",
    });
    const internetPanel = h(
      "div",
      { class: "card stack", id: "intake-internet-panel", hidden: true, style: { display: "none" } },
      h("h3", { class: "card__title", style: { fontSize: "14px" } }, "Internet details"),
      h("div", { class: "stack" }, internetAccessBoxes),
      roofBox
    );

    const servicesCard = h(
      "div",
      { class: "card stack" },
      h("h2", { class: "card__title" }, "Social services"),
      h("div", { class: "stack" }, serviceBoxes),
      internetPanel
    );

    // ---- address card ----------------------------------------------------
    const streetInput = h("input", {
      class: "input",
      id: "intake-street",
      name: "street_address",
      type: "text",
      autocomplete: "off",
      placeholder: "Street address",
    });
    const cityInput = h("input", {
      class: "input",
      id: "intake-city",
      name: "city_state",
      type: "text",
      autocomplete: "off",
      placeholder: "City, State",
    });
    const zipInput = h("input", {
      class: "input",
      id: "intake-zip",
      name: "zip_code",
      type: "text",
      inputmode: "numeric",
      autocomplete: "off",
      placeholder: "ZIP",
    });

    const addressCard = h(
      "div",
      { class: "card stack" },
      h("h2", { class: "card__title" }, "Delivery address"),
      h(
        "p",
        { class: "muted", style: { margin: "0" } },
        "Needed for furniture and other deliveries."
      ),
      field("intake-street", "Street address", streetInput),
      field("intake-city", "City, State", cityInput),
      field("intake-zip", "ZIP code", zipInput)
    );

    // ---- notes card ------------------------------------------------------
    const notesInput = h("textarea", {
      class: "input",
      id: "intake-notes",
      name: "notes",
      rows: "3",
      placeholder: "Anything else the team should know",
    });
    const notesCard = h(
      "div",
      { class: "card stack" },
      h("h2", { class: "card__title" }, "Notes"),
      field("intake-notes", "Notes", notesInput)
    );

    // ---- submit ----------------------------------------------------------
    const submitBtn = h(
      "button",
      { class: "btn btn-primary btn-block", type: "submit" },
      "Submit intake"
    );

    // Result region, replaced on each submit.
    const result = h("div", { id: "intake-result" });

    const form = h(
      "form",
      {
        class: "stack",
        novalidate: "novalidate",
        onsubmit: (e) => {
          e.preventDefault();
          doSubmit();
        },
      },
      contactCard,
      languagesCard,
      goodsCard,
      furniturePanel,
      servicesCard,
      addressCard,
      notesCard,
      submitBtn
    );

    clear(container);
    container.append(heading, form, result);

    renderGoodsChips();
    renderLanguageChips();
    setTimeout(() => phoneInput.focus(), 0);

    // ---- goods chip UI ---------------------------------------------------

    // Render one toggleable chip per common good + each custom good.
    function renderGoodsChips() {
      clear(goodsChips);
      const chips = [];
      COMMON_GOODS.forEach((g) => chips.push(goodsChip(g.key, g.label, false)));
      customGoods.forEach((value) => chips.push(goodsChip(value, prettyType(value), true)));
      goodsChips.append(...chips);
      // Every selection change flows through here, so this keeps the
      // furniture-details card in sync with the chips.
      syncFurniturePanel();
    }

    function goodsChip(value, label, removable) {
      const on = selectedGoods.has(value);
      const btn = h(
        "button",
        {
          type: "button",
          class: on ? "pill pill--on" : "pill",
          "aria-pressed": on ? "true" : "false",
          style: on
            ? {
                background: "var(--brand)",
                color: "var(--brand-ink)",
                borderColor: "var(--brand)",
              }
            : null,
          onclick: () => {
            if (selectedGoods.has(value)) selectedGoods.delete(value);
            else selectedGoods.add(value);
            renderGoodsChips();
          },
        },
        (on ? "✓ " : "") + label
      );
      if (!removable) return btn;
      // Custom goods get a small remove control.
      const remove = h(
        "button",
        {
          type: "button",
          class: "btn btn-ghost",
          style: { minHeight: "auto", minWidth: "auto", padding: "0 var(--s2)" },
          "aria-label": `Remove ${label}`,
          onclick: () => {
            selectedGoods.delete(value);
            const i = customGoods.indexOf(value);
            if (i >= 0) customGoods.splice(i, 1);
            renderGoodsChips();
          },
        },
        "×"
      );
      return h("span", { class: "row", style: { gap: "var(--s1)" } }, btn, remove);
    }

    function addCustomGood() {
      const value = goodsAddInput.value.trim();
      if (!value) return;
      const known = COMMON_GOODS.some((g) => g.key === value || g.label.toLowerCase() === value.toLowerCase());
      if (!known && !customGoods.includes(value)) customGoods.push(value);
      selectedGoods.add(value);
      goodsAddInput.value = "";
      renderGoodsChips();
      goodsAddInput.focus();
    }

    // ---- language chip UI ------------------------------------------------

    function renderLanguageChips() {
      clear(languageChips);
      languageChips.append(
        ...customLanguages.map((lang) =>
          h(
            "span",
            { class: "row", style: { gap: "var(--s1)" } },
            h("span", { class: "pill" }, lang),
            h(
              "button",
              {
                type: "button",
                class: "btn btn-ghost",
                style: { minHeight: "auto", minWidth: "auto", padding: "0 var(--s2)" },
                "aria-label": `Remove ${lang}`,
                onclick: () => {
                  const i = customLanguages.indexOf(lang);
                  if (i >= 0) customLanguages.splice(i, 1);
                  renderLanguageChips();
                },
              },
              "×"
            )
          )
        )
      );
    }

    function addCustomLanguage() {
      const value = languageAddInput.value.trim();
      if (!value) return;
      const known =
        COMMON_LANGUAGES.some((l) => l.toLowerCase() === value.toLowerCase()) ||
        customLanguages.some((l) => l.toLowerCase() === value.toLowerCase());
      if (!known) customLanguages.push(value);
      languageAddInput.value = "";
      renderLanguageChips();
      languageAddInput.focus();
    }

    // ---- internet panel visibility --------------------------------------

    function internetChecked() {
      const box = document.getElementById("svc-internet");
      return !!(box && box.checked);
    }

    function syncInternetPanel() {
      const show = internetChecked();
      internetPanel.hidden = !show;
      internetPanel.style.display = show ? "" : "none";
    }

    // ---- collect + submit ------------------------------------------------

    function collectLanguages() {
      const langs = [];
      COMMON_LANGUAGES.forEach((lang) => {
        const box = document.getElementById(`lang-${slug(lang)}`);
        if (box && box.checked) langs.push(lang);
      });
      customLanguages.forEach((lang) => {
        if (!langs.includes(lang)) langs.push(lang);
      });
      return langs;
    }

    function collectServices() {
      const svcs = [];
      SOCIAL_SERVICES.forEach((svc) => {
        const box = document.getElementById(`svc-${svc.key}`);
        if (box && box.checked) svcs.push(svc.key);
      });
      return svcs;
    }

    function collectInternetAccess() {
      if (!internetChecked()) return [];
      return INTERNET_ACCESS_OPTIONS.filter((opt) => {
        const box = document.getElementById(`net-${slug(opt)}`);
        return box && box.checked;
      });
    }

    function buildPayload() {
      const social = collectServices();
      const roofBoxEl = document.getElementById("intake-roof");
      const ackBoxEl = document.getElementById("intake-furniture-ack");
      const bedDetails = bedDetailsInput.value.trim();
      const payload = {
        phone_number: phoneInput.value.trim(),
        name: nameInput.value.trim() || null,
        email: emailInput.value.trim() || null,
        languages: collectLanguages(),
        request_types: [...selectedGoods],
        social_service_requests: social,
        internet_access: collectInternetAccess(),
        roof_accessible: internetChecked() && !!(roofBoxEl && roofBoxEl.checked),
        bed_details: furnitureSelected() && bedDetails ? [bedDetails] : [],
        furniture_acknowledgement: furnitureSelected() && !!(ackBoxEl && ackBoxEl.checked),
        notes: notesInput.value.trim() || null,
        street_address: streetInput.value.trim() || null,
        city_state: cityInput.value.trim() || null,
        zip_code: zipInput.value.trim() || null,
      };
      return payload;
    }

    async function doSubmit() {
      if (state.submitting) return;
      const phone = phoneInput.value.trim();
      if (!phone) {
        toast("A phone number is required.", "info");
        phoneInput.focus();
        return;
      }
      setBusy(true);
      showLoading("Submitting intake…");
      try {
        const res = await api.intake(buildPayload());
        // Keep the phone for the check-in deep link before the form resets.
        res.__phone = phone;
        renderResult(res);
        toast(
          res.created_household ? "New household created." : "Request added to existing household.",
          "success"
        );
        resetForm();
        // Scroll the result into view so the operator sees the outcome.
        result.scrollIntoView({ behavior: "smooth", block: "nearest" });
      } catch (err) {
        showError(err);
        toast((err && err.detail) || "Submission failed.", "error");
      } finally {
        setBusy(false);
      }
    }

    function resetForm() {
      form.reset();
      selectedGoods.clear();
      customGoods.length = 0;
      customLanguages.length = 0;
      renderGoodsChips();
      renderLanguageChips();
      syncInternetPanel();
      syncFurniturePanel();
      setTimeout(() => phoneInput.focus(), 0);
    }

    // ---- rendering helpers ----------------------------------------------

    function setBusy(busy) {
      state.submitting = busy;
      submitBtn.disabled = busy;
      submitBtn.textContent = busy ? "Submitting…" : "Submit intake";
    }

    function showLoading(msg) {
      clear(result);
      result.append(
        h(
          "div",
          { class: "loading" },
          h("span", { class: "spinner", role: "status", "aria-label": "Loading" }),
          msg
        )
      );
    }

    function showError(err) {
      clear(result);
      result.append(
        h(
          "div",
          { class: "card empty-state" },
          h("div", { class: "empty-state__icon" }, "⚠️"),
          h("div", {}, (err && err.detail) || "Something went wrong submitting the form."),
          h("button", { class: "btn", type: "button", onclick: doSubmit }, "Try again")
        )
      );
    }

    // Render the IntakeResult: created-vs-matched, opened requests, and any
    // duplicate / unknown / invalid-phone cautions.
    function renderResult(res) {
      clear(result);

      const createdCount =
        (res.created_request_ids || []).length +
        (res.created_social_service_request_ids || []).length;

      const rows = [];

      // Household outcome.
      rows.push(
        h(
          "div",
          { class: "row" },
          h(
            "span",
            { class: `badge ${res.created_household ? "badge-open" : "badge-delivered"}` },
            res.created_household ? "New household" : "Matched household"
          ),
          h("span", { class: "muted mono" }, `#${res.household_id}`)
        )
      );

      // Requests opened.
      rows.push(
        h(
          "div",
          {},
          createdCount === 0
            ? h(
                "span",
                { class: "muted" },
                res.already_processed
                  ? "Already processed — no new requests created."
                  : "No new requests opened (all may already be open)."
              )
            : h(
                "span",
                {},
                `Opened ${createdCount} request${createdCount === 1 ? "" : "s"} `,
                h(
                  "span",
                  { class: "muted" },
                  `(${(res.created_request_ids || []).length} goods, ${
                    (res.created_social_service_request_ids || []).length
                  } services)`
                )
              )
        )
      );

      // Cautions ----------------------------------------------------------
      if (!res.phone_valid) {
        rows.push(
          caution(
            "⚠️",
            "warn",
            "Phone number looks invalid — the household was saved without a stored number and won't receive text outreach until a valid number is on file."
          )
        );
      }
      if (res.already_processed) {
        rows.push(
          caution("ℹ️", "info", "This submission was already processed; it was not duplicated.")
        );
      }
      if ((res.skipped_duplicate_types || []).length) {
        rows.push(
          caution(
            "↩︎",
            "info",
            `Already open, so skipped: ${res.skipped_duplicate_types.map(prettyType).join(", ")}.`
          )
        );
      }
      if ((res.unknown_types || []).length) {
        rows.push(
          caution(
            "❓",
            "warn",
            `Not recognized and not added: ${res.unknown_types.map(prettyType).join(", ")}. Double-check spelling or use a catalog item.`
          )
        );
      }

      const card = h(
        "div",
        { class: "card stack" },
        h("h2", { class: "card__title" }, "Intake recorded"),
        ...rows,
        h(
          "div",
          { class: "row" },
          h(
            "button",
            {
              class: "btn btn-ghost",
              type: "button",
              onclick: () => {
                phoneInput.value = res.__phone || "";
                window.BAM.navigate("checkin", res.__phone ? { phone: res.__phone } : undefined);
              },
            },
            "Look up in check-in →"
          )
        )
      );

      result.append(card);
    }

    // A caution/notice line. tone: "warn" | "info".
    function caution(icon, tone, text) {
      const badgeCls = tone === "warn" ? "badge-timeout" : "badge-open";
      return h(
        "div",
        { class: "row", style: { alignItems: "flex-start", flexWrap: "nowrap" } },
        h("span", { class: `badge ${badgeCls}`, "aria-hidden": "true" }, icon),
        h("span", {}, text)
      );
    }
  }

  // ---- small shared builders (module scope) ------------------------------

  // A labelled field wrapper: <div class="field"><label/>...<hint?/></div>.
  function field(id, labelText, control, hint) {
    return h(
      "div",
      { class: "field" },
      h("label", { class: "label", for: id }, labelText),
      control,
      hint ? h("span", { class: "muted", style: { fontSize: "13px" } }, hint) : null
    );
  }

  // A checkbox + label row on one line, with a large tap target.
  function checkboxRow(id, labelText, opts) {
    const options = opts || {};
    const box = h("input", {
      type: "checkbox",
      id,
      value: options.value || labelText,
      onchange: options.onchange || null,
    });
    return h(
      "label",
      {
        class: "list-item list-item--selectable",
        for: id,
        style: { cursor: "pointer" },
      },
      box,
      h("span", { class: "list-item__body list-item__label" }, labelText)
    );
  }

  function slug(text) {
    return String(text)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  }

  window.BAM.registerView("intake", {
    title: "Intake",
    icon: "📝",
    render,
  });
})();
