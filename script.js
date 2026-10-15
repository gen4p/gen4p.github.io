const data = window.SUPPLEMENTARY_DATA;
const manifest = window.SUPPLEMENTARY_MANIFEST || {};
const baseFps = 15;
const playbackFps = 8;
let activeScenePauseAll = null;
const scenePlaybackControllers = [];
const resultColumns = [
    { label: "Ours", folder: "ours" },
    { label: "4RC", folder: "4rc" },
    { label: "V-DPM", folder: "vdpm" },
    { label: "OpenD4RT", folder: "opend4rt" },
];
const sharedControlsMarkup = '<div class="control-row"><button type="button" class="play-button">Play all</button><button type="button" class="reset-button">Reset</button><label class="fps-control">Speed <select class="fps-select"><option value="0.5">×0.5</option><option value="1" selected>×1</option><option value="1.5">×1.5</option></select></label><button type="button" class="loop-button is-enabled" aria-pressed="true">Loop</button></div><div class="timeline-row"><input class="timeline" type="range" min="0" max="0" step="1" value="0" aria-label="Synchronized video frame"></div>';

function pauseOtherScenes(sceneElement) {
    scenePlaybackControllers.forEach((item) => {
        if (item.sceneElement !== sceneElement && item.controller.isPlaying()) item.controller.pause();
    });
}

function createVideo(source) {
    const video = document.createElement("video");
    video.controls = false;
    video.muted = true;
    video.playsInline = true;
    video.preload = "metadata";
    video.src = source;
    return video;
}

function createMediaFigure(labelText, source, videos, isInput = false) {
    const figure = document.createElement("figure");
    const label = document.createElement("figcaption");
    const mediaFrame = document.createElement("div");
    label.textContent = labelText;
    mediaFrame.className = "media-frame";
    if (source) {
        const video = createVideo(source);
        video.dataset.method = labelText;
        if (isInput) video.classList.add("input-video");
        mediaFrame.appendChild(video);
        videos.push(video);
    } else {
        const placeholder = document.createElement("div");
        placeholder.className = "video-placeholder";
        placeholder.setAttribute("aria-label", `${labelText} video unavailable`);
        mediaFrame.appendChild(placeholder);
    }
    figure.append(label, mediaFrame);
    return figure;
}

function createSceneThumbnail(labelText, source) {
    const button = document.createElement("button");
    button.className = "carousel-thumbnail";
    button.type = "button";
    button.setAttribute("aria-label", `Show ${labelText}`);
    button.title = labelText;
    if (!source) {
        button.textContent = labelText;
        return button;
    }
    const video = createVideo(source);
    video.className = "carousel-thumbnail-video";
    video.preload = "auto";
    video.tabIndex = -1;
    video.setAttribute("aria-hidden", "true");
    video.addEventListener("loadeddata", () => video.pause(), { once: true });
    button.appendChild(video);
    return button;
}

function createViserFigure(source) {
    const figure = document.createElement("figure");
    const label = document.createElement("figcaption");
    const title = document.createElement("span");
    const interactionHint = document.createElement("small");
    const frame = document.createElement("div");
    title.textContent = "Interactive Results";
    interactionHint.className = "viser-interaction-hint";
    interactionHint.textContent = "Left-drag to rotate. Right-drag to pan.";
    label.append(title, interactionHint);
    frame.className = "viser-frame";
    if (source) {
        const iframe = document.createElement("iframe");
        iframe.dataset.src = `viser/index.html?playbackPath=${encodeURIComponent(`../${source}`)}`;
        iframe.title = "Interactive 4D reconstruction viewer";
        iframe.allow = "fullscreen";
        iframe.setAttribute("allowfullscreen", "");
        frame.appendChild(iframe);
    }
    figure.className = "viser-figure";
    figure.append(label, frame);
    return figure;
}

function configureInputAndViser(sceneElement, controls, inputVideo, iframe) {
    const playButton = controls.querySelector(".interactive-play-button");
    const resetCameraButton = controls.querySelector(".interactive-reset-camera-button");
    const speedSelect = controls.querySelector(".interactive-speed-select");
    const timeline = controls.querySelector(".interactive-timeline");
    let frameCallbackId = null;
    let playRequested = false;
    let viserTimeInput = null;
    let viserDuration = 0;
    let maxInputFrame = 0;
    let lastViserFrame = -1;
    let initialCameraSaved = false;
    let cameraSaveScheduled = false;

    function setViserTime(inputTime) {
        if (!viserTimeInput) return;
        const frame = Math.min(maxInputFrame, Math.max(0, Math.round(inputTime * baseFps)));
        if (frame === lastViserFrame) return;
        const targetTime = maxInputFrame > 0 ? frame / maxInputFrame * viserDuration : 0;
        const valueSetter = Object.getOwnPropertyDescriptor(iframe.contentWindow.HTMLInputElement.prototype, "value").set;
        valueSetter.call(viserTimeInput, targetTime.toFixed(4));
        viserTimeInput.dispatchEvent(new iframe.contentWindow.Event("input", { bubbles: true }));
        lastViserFrame = frame;
    }

    function updatePlayback(inputTime) {
        timeline.value = Math.min(maxInputFrame, Math.max(0, Math.round(inputTime * baseFps)));
        setViserTime(inputTime);
    }

    function scheduleInitialCameraSave() {
        if (cameraSaveScheduled || initialCameraSaved) return;
        cameraSaveScheduled = true;
        const contentWindow = iframe.contentWindow;
        contentWindow.requestAnimationFrame(() => contentWindow.requestAnimationFrame(() => contentWindow.setTimeout(() => {
            const saveCamera = contentWindow.__VISER_SAVE_CAMERA__;
            initialCameraSaved = typeof saveCamera === "function" && saveCamera();
            resetCameraButton.disabled = !initialCameraSaved;
        }, 50)));
    }

    function connectViserControls() {
        const slider = iframe.contentDocument.querySelector('[role="slider"][aria-valuemax]');
        const panel = slider ? slider.closest(".mantine-Paper-root") : null;
        const timeInput = panel ? panel.querySelector("input") : null;
        if (!viserTimeInput && slider && panel && timeInput) {
            viserDuration = Number(slider.getAttribute("aria-valuemax"));
            viserTimeInput = timeInput;
            lastViserFrame = -1;
            panel.style.setProperty("display", "none", "important");
            updatePlayback(inputVideo.currentTime);
            iframe.contentWindow.dispatchEvent(new iframe.contentWindow.Event("resize"));
        }
        if (viserTimeInput) scheduleInitialCameraSave();
        return Boolean(viserTimeInput);
    }

    function stopFrameMonitor() {
        if (frameCallbackId !== null && "cancelVideoFrameCallback" in inputVideo) inputVideo.cancelVideoFrameCallback(frameCallbackId);
        frameCallbackId = null;
    }

    function startFrameMonitor() {
        if (!("requestVideoFrameCallback" in inputVideo) || frameCallbackId !== null) return;
        function monitorFrame(now, metadata) {
            frameCallbackId = null;
            if (!playRequested || inputVideo.paused) return;
            updatePlayback(metadata.mediaTime);
            frameCallbackId = inputVideo.requestVideoFrameCallback(monitorFrame);
        }
        frameCallbackId = inputVideo.requestVideoFrameCallback(monitorFrame);
    }

    async function play(restart = false) {
        pauseOtherScenes(sceneElement);
        if (restart || inputVideo.ended || inputVideo.currentTime >= inputVideo.duration - 1e-3) inputVideo.currentTime = 0;
        playRequested = true;
        playButton.textContent = "Pause";
        playButton.classList.add("is-playing");
        try {
            await inputVideo.play();
            if (playRequested) startFrameMonitor();
        } catch {
            pause();
        }
    }

    function pause() {
        playRequested = false;
        inputVideo.pause();
        stopFrameMonitor();
        updatePlayback(inputVideo.currentTime);
        playButton.textContent = "Play";
        playButton.classList.remove("is-playing");
    }

    iframe.addEventListener("load", () => {
        iframe.contentDocument.addEventListener("wheel", (event) => {
            event.preventDefault();
            event.stopImmediatePropagation();
        }, { capture: true, passive: false });
        iframe.contentDocument.addEventListener("pointerdown", (event) => {
            if (event.button !== 1 && event.pointerType !== "touch") return;
            event.preventDefault();
            event.stopImmediatePropagation();
        }, true);
        iframe.contentWindow.addEventListener("keydown", (event) => {
            if (event.code !== "Space") return;
            event.preventDefault();
            event.stopImmediatePropagation();
        }, true);
        if (connectViserControls()) return;
        const observer = new iframe.contentWindow.MutationObserver(() => {
            if (!connectViserControls()) return;
            observer.disconnect();
        });
        observer.observe(iframe.contentDocument.body, { childList: true, subtree: true });
    });
    resetCameraButton.disabled = true;
    inputVideo.loop = true;
    inputVideo.playbackRate = Number(speedSelect.value) * playbackFps / baseFps;
    inputVideo.addEventListener("loadedmetadata", () => {
        maxInputFrame = Math.max(0, Math.round(inputVideo.duration * baseFps) - 1);
        timeline.max = maxInputFrame;
        updatePlayback(0);
    }, { once: true });
    if (!("requestVideoFrameCallback" in inputVideo)) inputVideo.addEventListener("timeupdate", () => updatePlayback(inputVideo.currentTime));
    playButton.addEventListener("click", () => {
        if (playRequested) pause();
        else play();
    });
    resetCameraButton.addEventListener("click", () => {
        const resetCamera = iframe.contentWindow.__VISER_RESET_CAMERA__;
        if (typeof resetCamera === "function") resetCamera();
    });
    speedSelect.addEventListener("change", () => {
        inputVideo.playbackRate = Number(speedSelect.value) * playbackFps / baseFps;
    });
    timeline.addEventListener("input", () => {
        pause();
        inputVideo.currentTime = Number(timeline.value) / baseFps;
        updatePlayback(inputVideo.currentTime);
    });
    const controller = { play, pause, isPlaying: () => playRequested };
    scenePlaybackControllers.push({ sceneElement, controller });
    return controller;
}

function appendHighlight(container, highlightText) {
    if (!highlightText) return;
    const highlight = document.createElement("p");
    const label = document.createElement("strong");
    highlight.className = "scene-highlight";
    label.textContent = "Ours Highlight:";
    highlight.append(label, ` ${highlightText}`);
    container.appendChild(highlight);
}

function configureSynchronizedVideos(sceneElement, videos, onComplete = null) {
    const playButton = sceneElement.querySelector(".play-button");
    const resetButton = sceneElement.querySelector(".reset-button");
    const fpsSelect = sceneElement.querySelector(".fps-select");
    const loopButton = sceneElement.querySelector(".loop-button");
    const timeline = sceneElement.querySelector(".timeline");
    const status = sceneElement.querySelector(".sync-status");
    if (videos.length === 0) {
        playButton.disabled = true;
        resetButton.disabled = true;
        fpsSelect.disabled = true;
        loopButton.disabled = true;
        timeline.disabled = true;
        status.textContent = "No videos were matched for this scene. Run python supp_webpage/generate_manifest.py from the repository root after adding the assets.";
        status.classList.add("warning");
        return { play: null, pause: null, isPlaying: () => false };
    }
    const masterVideo = videos[0];
    let loadedVideos = 0;
    let maxFrame = 0;
    let frameCallbackId = null;
    let playRequested = false;
    let loopEnabled = true;
    const completedVideos = new Set();

    function frameFromTime(time) {
        return Math.min(maxFrame, Math.max(0, Math.round(time * baseFps)));
    }

    function updateFrameDisplay(frame) {
        timeline.value = frame;
    }

    function seekAll(frame) {
        const targetFrame = Math.min(maxFrame, Math.max(0, Number(frame)));
        const targetTime = targetFrame / baseFps;
        completedVideos.clear();
        videos.forEach((video) => {
            video.currentTime = targetTime;
        });
        updateFrameDisplay(targetFrame);
    }

    function pauseAll(snapToFrame = true) {
        playRequested = false;
        videos.forEach((video) => video.pause());
        stopFrameMonitor();
        if (snapToFrame && Number.isFinite(masterVideo.duration)) seekAll(frameFromTime(masterVideo.currentTime));
        playButton.textContent = "Play all";
        playButton.classList.remove("is-playing");
        if (activeScenePauseAll === pauseAll) activeScenePauseAll = null;
    }

    function updatePlayback(mediaTime) {
        updateFrameDisplay(frameFromTime(mediaTime));
        videos.slice(1).forEach((video) => {
            if (!masterVideo.seeking && !video.seeking && !video.ended && video.readyState >= 3 && Math.abs(video.currentTime - mediaTime) > 3 / baseFps) video.currentTime = mediaTime;
        });
    }

    function stopFrameMonitor() {
        if (frameCallbackId !== null && "cancelVideoFrameCallback" in masterVideo) masterVideo.cancelVideoFrameCallback(frameCallbackId);
        frameCallbackId = null;
    }

    function startFrameMonitor() {
        if (!("requestVideoFrameCallback" in masterVideo) || frameCallbackId !== null) return;
        function monitorFrame(now, metadata) {
            frameCallbackId = null;
            if (masterVideo.paused || !playRequested) return;
            updatePlayback(metadata.mediaTime);
            frameCallbackId = masterVideo.requestVideoFrameCallback(monitorFrame);
        }
        frameCallbackId = masterVideo.requestVideoFrameCallback(monitorFrame);
    }

    async function playAll(restart = false) {
        pauseOtherScenes(sceneElement);
        if (activeScenePauseAll && activeScenePauseAll !== pauseAll) activeScenePauseAll();
        activeScenePauseAll = pauseAll;
        playRequested = true;
        playButton.textContent = "Pause all";
        playButton.classList.add("is-playing");
        if (restart || masterVideo.ended || Number(timeline.value) >= maxFrame) {
            videos.forEach((video) => video.pause());
            stopFrameMonitor();
            updateFrameDisplay(0);
            completedVideos.clear();
            await Promise.all(videos.map((video) => new Promise((resolve) => {
                function finishLoading() {
                    video.removeEventListener("canplay", finishLoading);
                    video.removeEventListener("error", finishLoading);
                    resolve();
                }
                video.addEventListener("canplay", finishLoading, { once: true });
                video.addEventListener("error", finishLoading, { once: true });
                video.preload = "auto";
                video.load();
            })));
            if (!playRequested || activeScenePauseAll !== pauseAll) return;
        }
        const playbackRate = Number(fpsSelect.value) * playbackFps / baseFps;
        videos.forEach((video) => {
            video.playbackRate = playbackRate;
            video.play().catch((error) => {
                if (!playRequested) return;
                status.textContent = `Could not play ${video.dataset.method} (${error.name}).`;
                status.classList.add("warning");
            });
        });
        startFrameMonitor();
    }

    videos.forEach((video) => {
        video.addEventListener("error", () => {
            status.textContent = `Could not load ${video.dataset.method}. Check the filename and video format.`;
            status.classList.add("warning");
        });
    });

    playButton.addEventListener("click", () => {
        if (playRequested) pauseAll();
        else playAll();
    });

    resetButton.addEventListener("click", () => {
        pauseAll(false);
        seekAll(0);
    });

    timeline.addEventListener("input", () => {
        pauseAll(false);
        seekAll(timeline.value);
    });

    fpsSelect.addEventListener("change", () => {
        const playbackRate = Number(fpsSelect.value) * playbackFps / baseFps;
        videos.forEach((video) => {
            video.playbackRate = playbackRate;
        });
    });

    loopButton.addEventListener("click", () => {
        loopEnabled = !loopEnabled;
        loopButton.classList.toggle("is-enabled", loopEnabled);
        loopButton.setAttribute("aria-pressed", loopEnabled ? "true" : "false");
    });

    videos.forEach((video) => video.addEventListener("ended", () => {
        completedVideos.add(video);
        if (!playRequested || completedVideos.size !== videos.length) return;
        if (onComplete && onComplete()) return;
        if (loopEnabled) playAll(true);
        else {
            pauseAll(false);
            seekAll(maxFrame);
        }
    }));

    if (!("requestVideoFrameCallback" in masterVideo)) {
        masterVideo.addEventListener("timeupdate", () => updatePlayback(masterVideo.currentTime));
    }

    videos.forEach((video) => {
        video.addEventListener("loadedmetadata", () => {
            loadedVideos += 1;
            if (loadedVideos !== videos.length) return;
            const durations = videos.map((item) => item.duration);
            maxFrame = Math.max(0, Math.round(Math.min(...durations) * baseFps) - 1);
            timeline.max = maxFrame;
            seekAll(0);
            if (Math.max(...durations) - Math.min(...durations) > 0.1) {
                status.textContent = "Warning: the available videos have different durations and may not represent aligned content.";
                status.classList.add("warning");
            } else {
                status.textContent = "";
            }
        }, { once: true });
    });
    const controller = { play: playAll, pause: pauseAll, isPlaying: () => playRequested };
    scenePlaybackControllers.push({ sceneElement, controller });
    return controller;
}

function renderComparisonScenes() {
    const container = document.querySelector("#comparison-scenes");
    if (data.comparisonScenes.length === 0) {
        container.innerHTML = '<p class="empty-state">No comparison scenes are configured yet. Register scene keywords in <code>config.js</code>, then run <code>python supp_webpage/generate_manifest.py</code> from the repository root.</p>';
        return;
    }

    const carousel = document.createElement("div");
    const carouselTrack = document.createElement("div");
    const previousButton = document.createElement("button");
    const nextButton = document.createElement("button");
    const pagination = document.createElement("div");
    const scenes = [];
    let activeSceneIndex = 0;
    let isSliding = false;
    carousel.className = "additional-carousel";
    carouselTrack.className = "additional-carousel-track";
    previousButton.className = "carousel-arrow carousel-arrow-previous";
    previousButton.type = "button";
    previousButton.textContent = "\u2039";
    previousButton.title = "Previous scene";
    previousButton.setAttribute("aria-label", "Previous scene");
    nextButton.className = "carousel-arrow carousel-arrow-next";
    nextButton.type = "button";
    nextButton.textContent = "\u203a";
    nextButton.title = "Next scene";
    nextButton.setAttribute("aria-label", "Next scene");
    pagination.className = "carousel-thumbnails comparison-thumbnails";
    pagination.setAttribute("aria-label", "Comparison scenes");

    data.comparisonScenes.forEach((scene, index) => {
        const article = document.createElement("article");
        article.className = "additional-card";
        article.id = `comparison-scene-${scene.keyword}`;
        article.hidden = index !== 0;
        const inputVideos = [];
        const resultVideos = [];
        const sceneFiles = (manifest.comparison || {})[scene.keyword] || {};
        const topRow = document.createElement("div");
        topRow.className = "comparison-top-row";
        const inputSource = sceneFiles.input ? `assets/1-comp/input/${sceneFiles.input}` : null;
        const inputFigure = createMediaFigure(scene.title, inputSource, inputVideos, true);
        inputFigure.classList.add("input-figure");
        const viserFigure = createViserFigure(scene.viser);
        const viserIframe = viserFigure.querySelector("iframe");
        topRow.append(inputFigure, viserFigure);

        const interactiveControls = document.createElement("div");
        interactiveControls.className = "interactive-controls";
        interactiveControls.innerHTML = '<button type="button" class="interactive-play-button">Play</button><button type="button" class="interactive-reset-camera-button">Reset Camera</button><label class="fps-control">Speed <select class="fps-select interactive-speed-select"><option value="0.5">×0.5</option><option value="1" selected>×1</option><option value="1.5">×1.5</option></select></label><input class="interactive-timeline" type="range" min="0" max="0" step="1" value="0" aria-label="Input and interactive reconstruction timeline">';

        const comparisonToggle = document.createElement("button");
        const comparisonToggleLabel = document.createElement("span");
        const comparisonToggleIcon = document.createElement("span");
        comparisonToggle.className = "comparison-toggle";
        comparisonToggle.type = "button";
        comparisonToggle.title = "Expand for Tracking Result Comparisons";
        comparisonToggle.setAttribute("aria-label", "Expand for Tracking Result Comparisons");
        comparisonToggle.setAttribute("aria-expanded", "false");
        comparisonToggleLabel.className = "comparison-toggle-label";
        comparisonToggleLabel.textContent = "Expand for Tracking Result Comparisons";
        comparisonToggleIcon.className = "comparison-toggle-icon";
        comparisonToggleIcon.textContent = "\u2304";
        comparisonToggle.append(comparisonToggleLabel, comparisonToggleIcon);

        const comparisonDisclosure = document.createElement("div");
        comparisonDisclosure.className = "comparison-disclosure";
        comparisonDisclosure.hidden = true;
        const controls = document.createElement("div");
        controls.className = "shared-controls comparison-controls";
        controls.innerHTML = sharedControlsMarkup;
        comparisonDisclosure.appendChild(controls);
        article.append(interactiveControls, topRow, comparisonToggle, comparisonDisclosure);

        const scroll = document.createElement("div");
        scroll.className = "comparison-scroll";
        const grid = document.createElement("div");
        grid.className = "comparison-grid";
        resultColumns.forEach((column) => {
            const filename = sceneFiles[column.folder];
            const source = filename ? `assets/1-comp/${column.folder}/${filename}` : null;
            grid.appendChild(createMediaFigure(column.label, source, resultVideos));
        });
        scroll.appendChild(grid);
        comparisonDisclosure.appendChild(scroll);

        if (scene.caption) {
            const caption = document.createElement("p");
            caption.className = "caption";
            caption.textContent = scene.caption;
            article.appendChild(caption);
        }
        appendHighlight(article, scene.highlight);

        const status = document.createElement("p");
        status.className = "sync-status";
        status.setAttribute("aria-live", "polite");
        status.textContent = "Loading video metadata...";
        article.appendChild(status);
        carouselTrack.appendChild(article);

        const pageButton = createSceneThumbnail(scene.title, inputSource);
        pagination.appendChild(pageButton);
        const controller = configureSynchronizedVideos(article, resultVideos);
        const interactiveController = configureInputAndViser(article, interactiveControls, inputVideos[0], viserIframe);
        comparisonToggle.addEventListener("click", () => {
            const expanded = comparisonToggle.getAttribute("aria-expanded") !== "true";
            comparisonToggle.setAttribute("aria-expanded", expanded ? "true" : "false");
            comparisonToggleLabel.textContent = expanded ? "Collapse Tracking Result Comparisons" : "Expand for Tracking Result Comparisons";
            comparisonToggle.setAttribute("aria-label", comparisonToggleLabel.textContent);
            comparisonToggle.title = comparisonToggleLabel.textContent;
            comparisonDisclosure.hidden = !expanded;
            if (!expanded && controller.pause) controller.pause();
        });
        scenes.push({ article, pageButton, controller, interactiveController, viserIframe });
    });

    carousel.append(carouselTrack, previousButton, nextButton);
    container.append(carousel, pagination);

    function showScene(index, play = false, direction = "next", animate = true) {
        if (isSliding) return;
        const nextIndex = (index + scenes.length) % scenes.length;
        if (nextIndex === activeSceneIndex) return;
        const previousScene = scenes[activeSceneIndex];
        const nextScene = scenes[nextIndex];
        const interactiveWasPlaying = previousScene.interactiveController.isPlaying();
        if (previousScene.controller.pause) previousScene.controller.pause(false);
        previousScene.interactiveController.pause();
        activeSceneIndex = nextIndex;
        scenes.forEach((scene, sceneIndex) => {
            const isActive = sceneIndex === activeSceneIndex;
            if (scene !== previousScene && scene !== nextScene) scene.article.hidden = true;
            scene.pageButton.setAttribute("aria-current", isActive ? "true" : "false");
        });
        nextScene.article.hidden = false;
        requestAnimationFrame(() => {
            if (!nextScene.viserIframe.hasAttribute("src")) nextScene.viserIframe.src = nextScene.viserIframe.dataset.src;
            else nextScene.viserIframe.contentWindow.dispatchEvent(new nextScene.viserIframe.contentWindow.Event("resize"));
        });
        if (!animate) {
            previousScene.article.hidden = true;
            if (play && nextScene.controller.play) nextScene.controller.play();
            if (interactiveWasPlaying) nextScene.interactiveController.play();
            return;
        }
        isSliding = true;
        carouselTrack.classList.toggle("slide-previous", direction === "previous");
        previousScene.article.classList.add("is-leaving");
        nextScene.article.classList.add("is-entering");
        nextScene.article.addEventListener("animationend", (event) => {
            if (event.target !== nextScene.article) return;
            previousScene.article.hidden = true;
            previousScene.article.classList.remove("is-leaving");
            nextScene.article.classList.remove("is-entering");
            carouselTrack.classList.remove("slide-previous");
            isSliding = false;
            if (play && nextScene.controller.play) nextScene.controller.play();
            if (interactiveWasPlaying) nextScene.interactiveController.play();
        }, { once: true });
    }

    previousButton.addEventListener("click", () => showScene(activeSceneIndex - 1, scenes[activeSceneIndex].controller.isPlaying(), "previous"));
    nextButton.addEventListener("click", () => showScene(activeSceneIndex + 1, scenes[activeSceneIndex].controller.isPlaying(), "next"));
    scenes.forEach((scene, index) => scene.pageButton.addEventListener("click", () => {
        const direction = index < activeSceneIndex ? "previous" : "next";
        showScene(index, scenes[activeSceneIndex].controller.isPlaying(), direction);
    }));
    const initialKeyword = window.location.hash.replace("#comparison-scene-", "");
    const initialSceneIndex = data.comparisonScenes.findIndex((scene) => scene.keyword === initialKeyword);
    if (initialSceneIndex > 0) showScene(initialSceneIndex, false, "next", false);
    else {
        scenes[0].pageButton.setAttribute("aria-current", "true");
        if (scenes[0].viserIframe) requestAnimationFrame(() => {
            scenes[0].viserIframe.src = scenes[0].viserIframe.dataset.src;
        });
    }
}

function renderAdditionalResults() {
    const container = document.querySelector("#additional-results");
    if (data.additionalResults.length === 0) {
        container.innerHTML = '<p class="empty-state">No additional results are configured yet. Add input/result videos under <code>assets/2-additional/</code>, register their scene keywords in <code>config.js</code>, then regenerate the manifest.</p>';
        return;
    }

    const header = document.createElement("div");
    const carousel = document.createElement("div");
    const carouselTrack = document.createElement("div");
    const previousButton = document.createElement("button");
    const nextButton = document.createElement("button");
    const pagination = document.createElement("div");
    const slidingModeButton = document.createElement("button");
    const scenes = [];
    let activeSceneIndex = 0;
    let autoSliding = true;
    let isSliding = false;
    header.className = "additional-carousel-header";
    slidingModeButton.className = "sliding-mode-button is-auto";
    slidingModeButton.type = "button";
    slidingModeButton.textContent = "Auto Sliding";
    slidingModeButton.setAttribute("aria-pressed", "true");
    carousel.className = "additional-carousel";
    carouselTrack.className = "additional-carousel-track";
    previousButton.className = "carousel-arrow carousel-arrow-previous";
    previousButton.type = "button";
    previousButton.textContent = "\u2039";
    previousButton.title = "Previous scene";
    previousButton.setAttribute("aria-label", "Previous scene");
    nextButton.className = "carousel-arrow carousel-arrow-next";
    nextButton.type = "button";
    nextButton.textContent = "\u203a";
    nextButton.title = "Next scene";
    nextButton.setAttribute("aria-label", "Next scene");
    pagination.className = "carousel-thumbnails";
    pagination.setAttribute("aria-label", "Additional result scenes");
    header.appendChild(slidingModeButton);
    container.append(header, carousel, pagination);

    data.additionalResults.forEach((result, index) => {
        const article = document.createElement("article");
        article.className = "additional-card";
        article.id = `additional-scene-${result.keyword}`;
        article.hidden = index !== 0;
        const videos = [];
        const resultFiles = (manifest.additional || {})[result.keyword] || {};
        const topRow = document.createElement("div");
        topRow.className = "scene-top-row";
        const inputSource = resultFiles.input ? `assets/${resultFiles.input}` : null;
        const inputFigure = createMediaFigure(result.title, inputSource, videos, true);
        inputFigure.classList.add("input-figure");
        const controls = document.createElement("div");
        controls.className = "shared-controls";
        controls.innerHTML = sharedControlsMarkup;
        topRow.append(inputFigure, controls);
        article.appendChild(topRow);

        const scroll = document.createElement("div");
        scroll.className = "additional-scroll";
        const grid = document.createElement("div");
        grid.className = "additional-result-grid";
        resultColumns.forEach((column) => {
            const source = resultFiles[column.folder] ? `assets/${resultFiles[column.folder]}` : null;
            grid.appendChild(createMediaFigure(column.label, source, videos));
        });
        scroll.appendChild(grid);
        article.appendChild(scroll);

        if (result.caption) {
            const caption = document.createElement("p");
            caption.className = "caption";
            caption.textContent = result.caption;
            article.appendChild(caption);
        }
        appendHighlight(article, result.highlight);

        const status = document.createElement("p");
        status.className = "sync-status";
        status.setAttribute("aria-live", "polite");
        status.textContent = "Loading video metadata...";
        article.appendChild(status);
        carouselTrack.appendChild(article);

        const pageButton = createSceneThumbnail(result.title, inputSource);
        pagination.appendChild(pageButton);
        const controller = configureSynchronizedVideos(article, videos, () => {
            if (!autoSliding || index !== activeSceneIndex || isSliding) return false;
            return showScene(index + 1, true, "next", true, true);
        });
        scenes.push({ article, pageButton, controller });
    });

    carousel.append(carouselTrack, previousButton, nextButton);

    function showScene(index, play = false, direction = "next", animate = true, restart = false) {
        if (isSliding) return false;
        const nextIndex = (index + scenes.length) % scenes.length;
        if (nextIndex === activeSceneIndex) return false;
        const previousScene = scenes[activeSceneIndex];
        const nextScene = scenes[nextIndex];
        if (previousScene.controller.pause) previousScene.controller.pause(false);
        activeSceneIndex = nextIndex;
        scenes.forEach((scene, sceneIndex) => {
            const isActive = sceneIndex === activeSceneIndex;
            if (scene !== previousScene && scene !== nextScene) scene.article.hidden = true;
            scene.pageButton.setAttribute("aria-current", isActive ? "true" : "false");
        });
        if (!animate) {
            previousScene.article.hidden = true;
            nextScene.article.hidden = false;
            if (play && nextScene.controller.play) nextScene.controller.play(restart);
            return true;
        }
        isSliding = true;
        nextScene.article.hidden = false;
        carouselTrack.classList.toggle("slide-previous", direction === "previous");
        previousScene.article.classList.add("is-leaving");
        nextScene.article.classList.add("is-entering");
        nextScene.article.addEventListener("animationend", (event) => {
            if (event.target !== nextScene.article) return;
            previousScene.article.hidden = true;
            previousScene.article.classList.remove("is-leaving");
            nextScene.article.classList.remove("is-entering");
            carouselTrack.classList.remove("slide-previous");
            isSliding = false;
            if (play && nextScene.controller.play) nextScene.controller.play(restart);
        }, { once: true });
        return true;
    }

    function updateLoopControls() {
        scenes.forEach((scene) => {
            scene.article.querySelector(".loop-button").disabled = autoSliding;
        });
    }

    previousButton.addEventListener("click", () => showScene(activeSceneIndex - 1, scenes[activeSceneIndex].controller.isPlaying(), "previous"));
    nextButton.addEventListener("click", () => showScene(activeSceneIndex + 1, scenes[activeSceneIndex].controller.isPlaying(), "next"));
    scenes.forEach((scene, index) => scene.pageButton.addEventListener("click", () => {
        const direction = index < activeSceneIndex ? "previous" : "next";
        showScene(index, scenes[activeSceneIndex].controller.isPlaying(), direction);
    }));
    slidingModeButton.addEventListener("click", () => {
        autoSliding = !autoSliding;
        slidingModeButton.classList.toggle("is-auto", autoSliding);
        slidingModeButton.textContent = autoSliding ? "Auto Sliding" : "Manual Sliding";
        slidingModeButton.setAttribute("aria-pressed", autoSliding ? "true" : "false");
        updateLoopControls();
    });
    const initialKeyword = window.location.hash.replace("#additional-scene-", "");
    const initialSceneIndex = data.additionalResults.findIndex((result) => result.keyword === initialKeyword);
    if (initialSceneIndex > 0) showScene(initialSceneIndex, false, "next", false);
    else {
        scenes[0].pageButton.setAttribute("aria-current", "true");
    }
    updateLoopControls();
}

renderComparisonScenes();
renderAdditionalResults();
