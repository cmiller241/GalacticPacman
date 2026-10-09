// js/gallery.js
//
// Media page: a thumbnail grid built from website/screenshots/, each
// opening the full-size shot in a lightbox overlay — a dimmed/grayed
// backdrop over everything else on the page with the photo centered
// on top. Self-contained and DOM-ready by the time this script runs
// (it's loaded at the end of body), so it just builds and wires
// itself up immediately rather than waiting on main.js's own
// canvas/image loading.

"use strict";

const Gallery = (() => {
  // Real filenames in website/screenshots/ — add new ones here as
  // they're dropped in. Spaces in the actual filenames are encoded via
  // encodeURIComponent below rather than renaming the files.
  const FILES = [
    "Screenshot 2026-10-06 171133.png",
    "Screenshot 2026-10-06 171335.png",
    "Screenshot 2026-10-06 171532.png",
    "Screenshot 2026-10-06 171652.png",
    "Screenshot 2026-10-06 171701.png",
    "Screenshot 2026-10-06 171727.png",
    "Screenshot 2026-10-06 171845.png",
    "Screenshot 2026-10-06 172024.png",
  ];
  const DIR = "screenshots/";

  let currentIndex = 0;
  let lightbox, lightboxImg, counterEl;

  function srcFor(file) {
    return DIR + encodeURIComponent(file);
  }

  function init(containerId) {
    const container = document.getElementById(containerId);
    if (!container || FILES.length === 0) return;

    const grid = document.createElement("div");
    grid.className = "gallery";
    FILES.forEach((file, i) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "thumb";
      btn.setAttribute("aria-label", `Open screenshot ${i + 1} of ${FILES.length}`);

      const img = document.createElement("img");
      img.src = srcFor(file);
      img.loading = "lazy";
      img.alt = `Asteroid Bob — screenshot ${i + 1}`;
      btn.appendChild(img);

      btn.addEventListener("click", () => open(i));
      grid.appendChild(btn);
    });
    container.appendChild(grid);

    buildLightbox();
  }

  function buildLightbox() {
    lightbox = document.createElement("div");
    lightbox.className = "lightbox";
    lightbox.hidden = true;

    // Clicking the dimmed backdrop closes it; clicking the photo/
    // controls themselves (inside .lightbox-figure) does not, via
    // stopPropagation on the figure below.
    lightbox.addEventListener("click", close);

    const figure = document.createElement("div");
    figure.className = "lightbox-figure";
    figure.addEventListener("click", (e) => e.stopPropagation());

    lightboxImg = document.createElement("img");
    lightboxImg.className = "lightbox-img";
    figure.appendChild(lightboxImg);

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "lightbox-close";
    closeBtn.setAttribute("aria-label", "Close");
    closeBtn.textContent = "×";
    closeBtn.addEventListener("click", close);
    figure.appendChild(closeBtn);

    if (FILES.length > 1) {
      const prevBtn = document.createElement("button");
      prevBtn.type = "button";
      prevBtn.className = "lightbox-nav lightbox-prev";
      prevBtn.setAttribute("aria-label", "Previous screenshot");
      prevBtn.textContent = "‹";
      prevBtn.addEventListener("click", () => step(-1));
      figure.appendChild(prevBtn);

      const nextBtn = document.createElement("button");
      nextBtn.type = "button";
      nextBtn.className = "lightbox-nav lightbox-next";
      nextBtn.setAttribute("aria-label", "Next screenshot");
      nextBtn.textContent = "›";
      nextBtn.addEventListener("click", () => step(1));
      figure.appendChild(nextBtn);

      counterEl = document.createElement("span");
      counterEl.className = "lightbox-counter";
      figure.appendChild(counterEl);
    }

    lightbox.appendChild(figure);
    document.body.appendChild(lightbox);

    document.addEventListener("keydown", (e) => {
      if (lightbox.hidden) return;
      if (e.key === "Escape") close();
      else if (e.key === "ArrowLeft") step(-1);
      else if (e.key === "ArrowRight") step(1);
    });
  }

  function open(index) {
    currentIndex = index;
    render();
    lightbox.hidden = false;
    document.body.classList.add("lightbox-open");
  }

  function close() {
    lightbox.hidden = true;
    document.body.classList.remove("lightbox-open");
  }

  function step(delta) {
    currentIndex = (currentIndex + delta + FILES.length) % FILES.length;
    render();
  }

  function render() {
    lightboxImg.src = srcFor(FILES[currentIndex]);
    lightboxImg.alt = `Asteroid Bob — screenshot ${currentIndex + 1}`;
    if (counterEl) counterEl.textContent = `${currentIndex + 1} / ${FILES.length}`;
  }

  init("mediaGallery");

  return { init };
})();
