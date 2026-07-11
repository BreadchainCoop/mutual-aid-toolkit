/* Shifts & coverage board — placeholder registered at boot; the full view
 * (role slots, language requirements, claim/release, gap visibility) renders
 * from BAM.api.listShifts()/claimShift()/releaseShift(). */
(function () {
  "use strict";

  const { h, clear } = window.BAM;

  async function render(container) {
    clear(container);
    container.append(
      h("div", { class: "empty-state" }, h("div", {}, "Shifts view loading…"))
    );
  }

  window.BAM.registerView("shifts", {
    title: "Shifts",
    icon: "🗓️",
    render,
  });
})();
