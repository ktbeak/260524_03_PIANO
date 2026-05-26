/**
 * AuraPiano - Smart Piano for Classroom
 * Core Audio & UI Logic
 * Powered by Web Audio API & Pure Javascript
 */

// --- GLOBAL APP STATE ---
const state = {
    // Audio Context & Nodes
    audioCtx: null,
    masterGain: null,
    reverbNode: null,
    reverbWetGain: null,
    reverbDryGain: null,
    limiterNode: null,
    recorderNode: null, // ScriptProcessor for recording
    recordingStreamNode: null, // Routing destination for capture
    
    // Synthesizer State
    currentPreset: 'grand', // 'grand', 'electric', 'harpsichord', 'ambient'
    activeVoices: new Map(), // Active playing voices: noteNumber -> Voice instance
    sustainPedalActive: false,
    sustainedVoices: new Set(), // Voices kept alive by sustain pedal
    
    // Reverb Parameters
    reverbDecay: 3.0, // seconds
    reverbWet: 0.35,  // 0.0 to 1.0
    
    // UI Settings
    labelType: 'korean', // 'none', 'korean', 'english'
    showKeyboardHints: true,
    zoomLevel: 100, // percentage
    
    // Metronome State
    metronomeActive: false,
    bpm: 120,
    nextNoteTime: 0.0,
    beatCount: 0,
    metronomeTimerId: null,
    
    // Recorder State
    isRecording: false,
    recordingStartTime: 0,
    recordingTimerId: null,
    leftChannelBuffer: [],
    rightChannelBuffer: [],
    recordingLength: 0
};

// --- NOTE DEFINITIONS (5 Octaves: C2 to C7) ---
// MIDI Note 36 (C2) to 96 (C7)
const START_MIDI = 36;
const END_MIDI = 96;
const NOTE_NAMES_ENG = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const NOTE_NAMES_KOR = ["도", "도#", "레", "레#", "미", "파", "파#", "솔", "솔#", "라", "라#", "시"];

// Computer Keyboard Map (MIDI 48 to 64: C3 to E4)
const KEY_MAP = {
    'KeyA': 48, // C3
    'KeyW': 49, // C#3
    'KeyS': 50, // D3
    'KeyE': 51, // D#3
    'KeyD': 52, // E3
    'KeyF': 53, // F3
    'KeyT': 54, // F#3
    'KeyG': 55, // G3
    'KeyY': 56, // G#3
    'KeyH': 57, // A3
    'KeyU': 58, // A#3
    'KeyJ': 59, // B3
    'KeyK': 60, // C4
    'KeyO': 61, // C#4
    'KeyL': 62, // D4
    'KeyP': 63, // D#4
    'Semicolon': 64, // E4
    'Quote': 65 // F4
};

// --- INITIALIZE AUDIO CONTEXT ---
function initAudio() {
    if (state.audioCtx) {
        if (state.audioCtx.state === 'suspended') {
            state.audioCtx.resume();
        }
        return;
    }

    try {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        state.audioCtx = new AudioContextClass();
        
        // 1. Create all Audio Nodes first
        state.masterGain = state.audioCtx.createGain();
        state.masterGain.gain.value = 0.8; // Default volume 80%

        state.limiterNode = state.audioCtx.createDynamicsCompressor();
        state.limiterNode.threshold.value = -1.0; // dB
        state.limiterNode.knee.value = 8;
        state.limiterNode.ratio.value = 12;
        state.limiterNode.attack.value = 0.003; // seconds
        state.limiterNode.release.value = 0.1;

        state.reverbNode = state.audioCtx.createConvolver();
        state.reverbWetGain = state.audioCtx.createGain();
        state.reverbDryGain = state.audioCtx.createGain();
        state.reverbWetGain.gain.value = state.reverbWet;
        state.reverbDryGain.gain.value = 1 - state.reverbWet;
        
        state.synthOutput = state.audioCtx.createGain();
        state.synthOutput.gain.value = 1.0;

        // 2. Generate and load the Reverb Impulse Response (Safe now because synthOutput exists!)
        generateImpulseResponse();

        // 3. Connect all Nodes
        state.synthOutput.connect(state.reverbDryGain);
        state.reverbDryGain.connect(state.masterGain);
        
        state.synthOutput.connect(state.reverbNode);
        state.reverbNode.connect(state.reverbWetGain);
        state.reverbWetGain.connect(state.masterGain);
        
        state.masterGain.connect(state.limiterNode);
        state.limiterNode.connect(state.audioCtx.destination);
        
        // Update UI Indicator
        const indicator = document.getElementById('latency-indicator');
        const statusLabel = indicator.querySelector('.status-label');
        indicator.querySelector('.dot').className = 'dot green';
        statusLabel.textContent = '오디오 상태: 활성화됨';
        document.getElementById('btn-audio-init').style.display = 'none';

        // Initialize recording node
        setupRecorder();
        
        console.log("Audio Context initialized successfully.");
    } catch (e) {
        console.error("Failed to initialize AudioContext:", e);
        alert("웹 오디오 API를 지원하지 않는 브라우저이거나 오디오 장치에 문제가 있습니다.");
    }
}

// Ensure Audio starts on user interaction
function triggerAudioInit(e) {
    if (!state.audioCtx) {
        initAudio();
    } else if (state.audioCtx.state === 'suspended') {
        state.audioCtx.resume();
    }
}

// Add multiple robust listeners for initializing audio context
document.addEventListener('click', (e) => {
    if (e.target && (e.target.closest('#btn-audio-init') || e.target.closest('.piano-key'))) {
        triggerAudioInit(e);
    }
});

document.addEventListener('touchstart', (e) => {
    if (e.target && (e.target.closest('.piano-key') || e.target.closest('#btn-audio-init'))) {
        triggerAudioInit(e);
    }
}, { passive: true });

document.addEventListener('mousedown', (e) => {
    if (e.target && (e.target.closest('.piano-key') || e.target.closest('#btn-audio-init'))) {
        triggerAudioInit(e);
    }
});

document.getElementById('btn-audio-init').addEventListener('click', initAudio);

// --- ALGORITHMIC CONVOLUTION REVERB GENERATOR ---
/**
 * Creates a stereo impulse response buffer on the fly.
 * Uses decaying white noise shaped to emulate room resonance (field presence).
 */
function generateImpulseResponse() {
    if (!state.audioCtx) return;
    
    const sampleRate = state.audioCtx.sampleRate;
    const length = sampleRate * state.reverbDecay;
    const impulseBuffer = state.audioCtx.createBuffer(2, length, sampleRate);
    
    const leftChannel = impulseBuffer.getChannelData(0);
    const rightChannel = impulseBuffer.getChannelData(1);
    
    for (let i = 0; i < length; i++) {
        // Exponential decay envelope
        const time = i / sampleRate;
        const decayEnv = Math.exp(-time * (7 / state.reverbDecay));
        
        // Wood resonance damping - high frequencies decay faster
        // This is done by adding a low-pass filter effect using a rolling average,
        // but simple frequency-dependent noise works beautifully in code.
        const filterWeight = 0.85 * (1 - time / state.reverbDecay);
        
        // Generate random noise for stereo width (-1.0 to 1.0)
        let randL = Math.random() * 2 - 1;
        let randR = Math.random() * 2 - 1;
        
        // Correlate channels slightly to keep central focus, but wide tails
        const correlatedL = randL * 0.7 + randR * 0.3;
        const correlatedR = randR * 0.7 + randL * 0.3;
        
        leftChannel[i] = correlatedL * decayEnv;
        rightChannel[i] = correlatedR * decayEnv;
    }
    
    // Apply to convolution node
    // Note: ConvolverNode.buffer cannot be set while it is active in some browsers,
    // so we recreate the node and reconnect it for seamless updates.
    if (state.reverbNode) {
        state.reverbNode.disconnect();
    }
    
    state.reverbNode = state.audioCtx.createConvolver();
    state.reverbNode.buffer = impulseBuffer;
    
    // Reconnect with defensive safeguards
    if (state.synthOutput && state.reverbWetGain) {
        state.synthOutput.connect(state.reverbNode);
        state.reverbNode.connect(state.reverbWetGain);
    }
}

function updateReverbSettings() {
    if (!state.audioCtx) return;
    
    // Smooth gain changes
    const now = state.audioCtx.currentTime;
    state.reverbWetGain.gain.setTargetAtTime(state.reverbWet, now, 0.05);
    state.reverbDryGain.gain.setTargetAtTime(1 - state.reverbWet, now, 0.05);
    
    // Re-generate impulse response buffer
    generateImpulseResponse();
}

// --- SYNTHESIZER ENGINE: VOICE CLASS ---
class Voice {
    constructor(midiNote, preset, audioCtx, destination) {
        this.midi = midiNote;
        this.preset = preset;
        this.ctx = audioCtx;
        this.dest = destination;
        this.freq = 440 * Math.pow(2, (midiNote - 69) / 12);
        
        this.oscillators = [];
        this.gains = [];
        this.voiceGainNode = null;
        
        this.trigger();
    }
    
    trigger() {
        const now = this.ctx.currentTime;
        
        // 1. Voice Master Gain Node with dynamic voice envelope
        this.voiceGainNode = this.ctx.createGain();
        this.voiceGainNode.gain.setValueAtTime(0, now);
        this.voiceGainNode.connect(this.dest);
        
        if (this.preset === 'grand') {
            this.triggerGrandPiano(now);
        } else if (this.preset === 'electric') {
            this.triggerElectricPiano(now);
        } else if (this.preset === 'harpsichord') {
            this.triggerHarpsichord(now);
        } else if (this.preset === 'ambient') {
            this.triggerAmbientPad(now);
        }
    }
    
    triggerGrandPiano(now) {
        // Grand Piano - Crystal Clear & Sparkling String Resonance (Brightened high harmonics)
        
        // Multiphonic Overtones & Micro-detuning (Bright clear intonation)
        // Added 5th and 6th harmonics to generate a sparkling, bell-like high clarity (맑고 명료한 음색)
        const overtones = [
            { ratio: 1.0,  amp: 1.0,  detune: 0 },       // Fundamental (Warm body)
            { ratio: 2.0,  amp: 0.58, detune: 1.8 },     // Octave (Bright clarity)
            { ratio: 3.0,  amp: 0.28, detune: -1.2 },    // Perfect 5th (Clean mid-highs)
            { ratio: 4.0,  amp: 0.16, detune: 2.4 },     // Double Octave (Sparkle)
            { ratio: 5.0,  amp: 0.08, detune: -0.8 },    // Major 3rd (High crystalline sheen)
            { ratio: 6.0,  amp: 0.05, detune: 1.5 }      // Octave + 5th (Bell-like detail)
        ];
        
        // Adjust decay based on note pitch: high keys decay faster
        const pitchFactor = Math.max(0.1, 1 - (this.midi - 36) / 70); // 0.1 to 1.0
        const decayTime = 1.5 + (4.5 * pitchFactor); // 1.5s for high C7, 6.0s for low C2
        
        overtones.forEach(overtone => {
            const osc = this.ctx.createOscillator();
            // Combination of sine and triangle for a warm but crisp acoustic pluck
            osc.type = overtone.ratio === 1 ? 'triangle' : 'sine';
            osc.frequency.setValueAtTime(this.freq * overtone.ratio, now);
            osc.detune.setValueAtTime(overtone.detune, now);
            
            const oscGain = this.ctx.createGain();
            oscGain.gain.setValueAtTime(0, now);
            // Attack tuned to 10ms for immediate articulation (명료함) while avoiding pops
            oscGain.gain.linearRampToValueAtTime(overtone.amp * 0.4, now + 0.010);
            oscGain.gain.exponentialRampToValueAtTime(0.0001, now + decayTime);
            
            osc.connect(oscGain);
            oscGain.connect(this.voiceGainNode);
            osc.start(now);
            
            this.oscillators.push(osc);
            this.gains.push(oscGain);
        });
        
        // Voice envelope ramp up
        this.voiceGainNode.gain.setValueAtTime(0, now);
        this.voiceGainNode.gain.linearRampToValueAtTime(1.0, now + 0.005);
    }
    
    triggerElectricPiano(now) {
        // E-Piano - Warm vibey Rhoades sound with metallic tine strike
        
        // 1. Tine strike (High pitch metallic ping)
        const tine = this.ctx.createOscillator();
        tine.type = 'sine';
        tine.frequency.setValueAtTime(this.freq * 8.0, now); // 8th harmonic tine
        
        const tineGain = this.ctx.createGain();
        tineGain.gain.setValueAtTime(0.3, now);
        tineGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.08);
        
        tine.connect(tineGain);
        tineGain.connect(this.voiceGainNode);
        tine.start(now);
        tine.stop(now + 0.1);
        this.oscillators.push(tine);
        this.gains.push(tineGain);
        
        // 2. Warm body oscillators (Sine & slightly detuned triangle for chorusing)
        const osc1 = this.ctx.createOscillator();
        osc1.type = 'sine';
        osc1.frequency.setValueAtTime(this.freq, now);
        
        const osc2 = this.ctx.createOscillator();
        osc2.type = 'triangle';
        osc2.frequency.setValueAtTime(this.freq, now);
        osc2.detune.setValueAtTime(6.0, now); // Micro chorus
        
        const g1 = this.ctx.createGain();
        g1.gain.setValueAtTime(0.65, now);
        g1.gain.exponentialRampToValueAtTime(0.0001, now + 4.5);
        
        const g2 = this.ctx.createGain();
        g2.gain.setValueAtTime(0.18, now);
        g2.gain.exponentialRampToValueAtTime(0.0001, now + 3.0);
        
        osc1.connect(g1);
        osc2.connect(g2);
        
        g1.connect(this.voiceGainNode);
        g2.connect(this.voiceGainNode);
        
        osc1.start(now);
        osc2.start(now);
        
        this.oscillators.push(osc1, osc2);
        this.gains.push(g1, g2);
        
        // Voice master envelope
        this.voiceGainNode.gain.setValueAtTime(0, now);
        this.voiceGainNode.gain.linearRampToValueAtTime(0.9, now + 0.01);
    }
    
    triggerHarpsichord(now) {
        // Harpsichord - Plucked string, rich high harmonics, immediate release
        const harmonics = [
            { ratio: 1.0, amp: 0.5 },
            { ratio: 2.0, amp: 0.35 },
            { ratio: 3.0, amp: 0.25 },
            { ratio: 4.0, amp: 0.15 },
            { ratio: 5.0, amp: 0.08 }
        ];
        
        harmonics.forEach(h => {
            const osc = this.ctx.createOscillator();
            // Sawtooth for rich string-plucking buzz
            osc.type = 'sawtooth';
            osc.frequency.setValueAtTime(this.freq * h.ratio, now);
            
            // Simple dynamic filter to simulate thin string properties
            const filter = this.ctx.createBiquadFilter();
            filter.type = 'highpass';
            filter.frequency.setValueAtTime(200, now); // cut thin low end
            
            const g = this.ctx.createGain();
            g.gain.setValueAtTime(0, now);
            g.gain.linearRampToValueAtTime(h.amp * 0.28, now + 0.002); // instant pluck attack
            g.gain.exponentialRampToValueAtTime(0.0001, now + 1.6); // fast pluck decay
            
            osc.connect(filter);
            filter.connect(g);
            g.connect(this.voiceGainNode);
            osc.start(now);
            
            this.oscillators.push(osc);
            this.gains.push(g);
        });
        
        this.voiceGainNode.gain.setValueAtTime(0, now);
        this.voiceGainNode.gain.linearRampToValueAtTime(1.0, now + 0.002);
    }
    
    triggerAmbientPad(now) {
        // Ambient Pad - Slow rise, rich dense detuned waves, extremely long decay
        const osc1 = this.ctx.createOscillator();
        osc1.type = 'sawtooth';
        osc1.frequency.setValueAtTime(this.freq, now);
        osc1.detune.setValueAtTime(-10, now);
        
        const osc2 = this.ctx.createOscillator();
        osc2.type = 'triangle';
        osc2.frequency.setValueAtTime(this.freq * 2.0, now);
        osc2.detune.setValueAtTime(10, now);
        
        const osc3 = this.ctx.createOscillator();
        osc3.type = 'sine';
        osc3.frequency.setValueAtTime(this.freq * 0.5, now); // sub octave warmth
        
        const filter = this.ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.Q.value = 1.0;
        filter.frequency.setValueAtTime(300, now);
        // Envelope sweep on filter
        filter.frequency.exponentialRampToValueAtTime(1200, now + 1.2);
        
        const g1 = this.ctx.createGain();
        const g2 = this.ctx.createGain();
        const g3 = this.ctx.createGain();
        
        g1.gain.setValueAtTime(0.18, now);
        g2.gain.setValueAtTime(0.25, now);
        g3.gain.setValueAtTime(0.35, now);
        
        osc1.connect(filter);
        osc2.connect(filter);
        osc3.connect(this.voiceGainNode); // directly connect bass sine for clean low end
        
        const filterGain = this.ctx.createGain();
        filterGain.gain.setValueAtTime(0.6, now);
        filter.connect(filterGain);
        filterGain.connect(this.voiceGainNode);
        
        osc1.start(now);
        osc2.start(now);
        osc3.start(now);
        
        this.oscillators.push(osc1, osc2, osc3);
        this.gains.push(g1, g2, g3);
        
        // Voice master envelope: Slow ambient attack
        this.voiceGainNode.gain.setValueAtTime(0, now);
        this.voiceGainNode.gain.linearRampToValueAtTime(0.8, now + 0.6); // 600ms long attack!
    }
    
    release() {
        const now = this.ctx.currentTime;
        
        // Set release times according to preset style
        let releaseTime = 0.25; // Default grand piano damper release
        
        if (this.preset === 'electric') {
            releaseTime = 0.35;
        } else if (this.preset === 'harpsichord') {
            releaseTime = 0.08; // harpsichord damping is immediate
        } else if (this.preset === 'ambient') {
            releaseTime = 2.2; // long ambient bleed tail
        }
        
        // Cancel scheduled gain events to prevent popping
        this.voiceGainNode.gain.cancelScheduledValues(now);
        const currentGainVal = this.voiceGainNode.gain.value;
        this.voiceGainNode.gain.setValueAtTime(currentGainVal, now);
        this.voiceGainNode.gain.exponentialRampToValueAtTime(0.0001, now + releaseTime);
        
        // Cleanly stop oscillators after release completes to save memory/processing
        setTimeout(() => {
            try {
                this.oscillators.forEach(osc => osc.stop());
                this.oscillators.forEach(osc => osc.disconnect());
                this.voiceGainNode.disconnect();
            } catch (e) {
                // Oscillator might have stopped already
            }
        }, releaseTime * 1000 + 100);
    }
}

// --- CORE VOICE TRIGGER LOGIC ---
function playNote(midiNote) {
    if (!state.audioCtx) initAudio();
    if (state.audioCtx.state === 'suspended') state.audioCtx.resume();
    
    // Stop note if already playing to re-trigger hammer strike
    if (state.activeVoices.has(midiNote)) {
        stopNote(midiNote, true);
    }
    
    // Create new Voice
    // Send output to synthOutput gain node
    const voice = new Voice(midiNote, state.currentPreset, state.audioCtx, state.synthOutput);
    state.activeVoices.set(midiNote, voice);
    
    // UI Feedback: Activate Key Element
    const keyElement = document.querySelector(`.piano-key[data-midi="${midiNote}"]`);
    if (keyElement) {
        keyElement.classList.add('active');
    }
}

function stopNote(midiNote, force = false) {
    const voice = state.activeVoices.get(midiNote);
    if (!voice) return;
    
    if (state.sustainPedalActive && !force) {
        // Hold voice in sustain list
        state.sustainedVoices.add(midiNote);
    } else {
        // Normal note-off release
        voice.release();
        state.activeVoices.delete(midiNote);
        
        // UI Feedback: Deactivate Key
        const keyElement = document.querySelector(`.piano-key[data-midi="${midiNote}"]`);
        if (keyElement) {
            keyElement.classList.remove('active');
        }
    }
}

// Sustain Pedal Control
function setSustainPedal(active) {
    state.sustainPedalActive = active;
    
    const sustainBtn = document.getElementById('btn-sustain');
    if (active) {
        sustainBtn.classList.add('active');
        sustainBtn.innerHTML = `
            <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/></svg>
            페달 밟음 (SPACE)
        `;
    } else {
        sustainBtn.classList.remove('active');
        sustainBtn.innerHTML = `
            <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M5 19v-2h14v2H5zm0-4v-2h14v2H5zm0-4V9h14v2H5zm0-4V5h14v2H5z"/></svg>
            페달 밟기 (SPACE)
        `;
        
        // Release all sustained voices that are not actively held down by fingers
        state.sustainedVoices.forEach(midiNote => {
            // Check if key is currently physically held down by verifying pointer state
            const keyEl = document.querySelector(`.piano-key[data-midi="${midiNote}"]`);
            const isPhysicallyPressed = keyEl && keyEl.dataset.pressed === 'true';
            
            if (!isPhysicallyPressed) {
                const voice = state.activeVoices.get(midiNote);
                if (voice) {
                    voice.release();
                    state.activeVoices.delete(midiNote);
                }
                
                if (keyEl) {
                    keyEl.classList.remove('active');
                }
            }
        });
        state.sustainedVoices.clear();
    }
}

// --- DYNAMIC PIANO KEYBOARD RENDERER ---
function renderKeyboard() {
    const keyboardContainer = document.getElementById('piano-keyboard');
    keyboardContainer.innerHTML = '';
    
    const whiteKeys = [];
    const blackKeys = [];
    
    // Build separate arrays for proper stacking and z-index ordering
    for (let midi = START_MIDI; midi <= END_MIDI; midi++) {
        const noteInOctave = midi % 12;
        const octaveNum = Math.floor(midi / 12) - 1;
        const isBlack = [1, 3, 6, 8, 10].includes(noteInOctave);
        
        const noteNameEng = NOTE_NAMES_ENG[noteInOctave] + octaveNum;
        const noteNameKor = NOTE_NAMES_KOR[noteInOctave] + octaveNum;
        
        const keyData = {
            midi: midi,
            isBlack: isBlack,
            nameEng: noteNameEng,
            nameKor: noteNameKor,
            noteIndex: noteInOctave
        };
        
        if (isBlack) {
            blackKeys.push(keyData);
        } else {
            whiteKeys.push(keyData);
        }
    }
    
    // Total White Keys defines keyboard width
    const whiteKeyCount = whiteKeys.length;
    
    // Render White Keys first
    whiteKeys.forEach((key, index) => {
        const keyEl = document.createElement('div');
        keyEl.className = 'piano-key piano-key-white';
        keyEl.setAttribute('data-midi', key.midi);
        keyEl.setAttribute('data-index', index);
        keyEl.setAttribute('data-pressed', 'false');
        
        // Label Element
        const labelEl = document.createElement('span');
        labelEl.className = 'key-label';
        labelEl.textContent = getLabelText(key);
        keyEl.appendChild(labelEl);
        
        // Computer Key mapping hint (C3 to E4)
        const shortcut = getKeyboardShortcut(key.midi);
        if (shortcut && state.showKeyboardHints) {
            const hintEl = document.createElement('span');
            hintEl.className = 'keyboard-hint';
            hintEl.textContent = shortcut;
            keyEl.appendChild(hintEl);
        }
        
        keyboardContainer.appendChild(keyEl);
    });
    
    // Render Black Keys with absolute positions overlapping white keys
    // The horizontal offset of a black key depends on which white key it is placed after
    blackKeys.forEach(key => {
        const keyEl = document.createElement('div');
        keyEl.className = 'piano-key piano-key-black';
        keyEl.setAttribute('data-midi', key.midi);
        keyEl.setAttribute('data-pressed', 'false');
        
        // Determine offset position
        let precedingWhiteKeyIndex = 0;
        
        // Algorithm: count how many white keys are before this black key in MIDI scale
        for (let m = START_MIDI; m < key.midi; m++) {
            const noteInOctave = m % 12;
            const isWhite = ![1, 3, 6, 8, 10].includes(noteInOctave);
            if (isWhite) {
                precedingWhiteKeyIndex++;
            }
        }
        
        // Store reference to white key index to position absolutely via CSS styles dynamically
        keyEl.style.left = `calc(${precedingWhiteKeyIndex} * var(--key-width) - (var(--black-key-width) / 2))`;
        
        // Label Element
        const labelEl = document.createElement('span');
        labelEl.className = 'key-label';
        labelEl.textContent = getLabelText(key);
        keyEl.appendChild(labelEl);
        
        // Computer Key mapping hint
        const shortcut = getKeyboardShortcut(key.midi);
        if (shortcut && state.showKeyboardHints) {
            const hintEl = document.createElement('span');
            hintEl.className = 'keyboard-hint';
            hintEl.textContent = shortcut;
            keyEl.appendChild(hintEl);
        }
        
        keyboardContainer.appendChild(keyEl);
    });
    
    // Set total container width dynamically
    keyboardContainer.style.width = `calc(${whiteKeyCount} * var(--key-width))`;
    
    // Add Mouse and Touch Listeners for keys
    attachKeyInteractionListeners();
}

function getLabelText(key) {
    if (state.labelType === 'none') return '';
    return state.labelType === 'korean' ? key.nameKor : key.nameEng;
}

function getKeyboardShortcut(midi) {
    for (const [key, val] of Object.entries(KEY_MAP)) {
        if (val === midi) {
            // Return visual simplified letters
            if (key === 'Semicolon') return ';';
            if (key === 'Quote') return "'";
            return key.replace('Key', '');
        }
    }
    return '';
}

// --- INTERACTIVE EVENTS & KEYBOARD GLISSANDO CONTROLLER ---
function attachKeyInteractionListeners() {
    const keys = document.querySelectorAll('.piano-key');
    let isMouseDown = false;
    
    // 1. Mouse Event Listeners (Glissando & triggers)
    document.addEventListener('mousedown', (e) => {
        if (e.target.closest('.piano-key')) {
            isMouseDown = true;
            triggerAudioInit(e);
        }
    });
    
    document.addEventListener('mouseup', () => {
        isMouseDown = false;
        keys.forEach(key => {
            if (key.getAttribute('data-pressed') === 'true') {
                key.setAttribute('data-pressed', 'false');
                const midi = parseInt(key.getAttribute('data-midi'));
                stopNote(midi);
            }
        });
    });
    
    keys.forEach(key => {
        const midi = parseInt(key.getAttribute('data-midi'));
        
        // Mouse Press
        key.addEventListener('mousedown', (e) => {
            e.preventDefault();
            key.setAttribute('data-pressed', 'true');
            playNote(midi);
        });
        
        // Mouse Slide-in (Glissando)
        key.addEventListener('mouseenter', () => {
            if (isMouseDown) {
                key.setAttribute('data-pressed', 'true');
                playNote(midi);
            }
        });
        
        // Mouse Slide-out
        key.addEventListener('mouseleave', () => {
            key.setAttribute('data-pressed', 'false');
            stopNote(midi);
        });
    });
    
    // 2. High-Performance Unified Touch Drag Tracker (iPad & Tablet glissando support)
    const keyboardContainer = document.getElementById('piano-keyboard');
    
    function handleTouchSwipe(e) {
        const currentMidiTouched = new Set();
        
        // Find all keys currently under active finger coordinates
        for (let i = 0; i < e.touches.length; i++) {
            const touch = e.touches[i];
            const element = document.elementFromPoint(touch.clientX, touch.clientY);
            const keyEl = element ? element.closest('.piano-key') : null;
            
            if (keyEl) {
                const midi = parseInt(keyEl.getAttribute('data-midi'));
                currentMidiTouched.add(midi);
                
                if (keyEl.getAttribute('data-pressed') !== 'true') {
                    keyEl.setAttribute('data-pressed', 'true');
                    playNote(midi);
                }
            }
        }
        
        // Stop notes for keys that are no longer touched
        keys.forEach(key => {
            const midi = parseInt(key.getAttribute('data-midi'));
            if (key.getAttribute('data-pressed') === 'true' && !currentMidiTouched.has(midi)) {
                key.setAttribute('data-pressed', 'false');
                stopNote(midi);
            }
        });
    }
    
    keyboardContainer.addEventListener('touchstart', (e) => {
        e.preventDefault(); // Stop mobile browser scrolling/zooming on the keyboard
        triggerAudioInit(e);
        handleTouchSwipe(e);
    }, { passive: false });
    
    keyboardContainer.addEventListener('touchmove', (e) => {
        e.preventDefault();
        handleTouchSwipe(e);
    }, { passive: false });
    
    keyboardContainer.addEventListener('touchend', (e) => {
        e.preventDefault();
        handleTouchSwipe(e);
    }, { passive: false });
    
    keyboardContainer.addEventListener('touchcancel', (e) => {
        e.preventDefault();
        handleTouchSwipe(e);
    }, { passive: false });
}

// Computer QWERTY Keys Map Listeners
const activeKeyboardKeys = new Set(); // Prevent keydown repeating triggers

document.addEventListener('keydown', (e) => {
    // Exclude if inputs are focused
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    
    // Spacebar Sustain Pedal Trigger
    if (e.code === 'Space') {
        e.preventDefault();
        if (!state.sustainPedalActive) {
            setSustainPedal(true);
        }
        return;
    }
    
    const midi = KEY_MAP[e.code];
    if (midi && !activeKeyboardKeys.has(e.code)) {
        activeKeyboardKeys.add(e.code);
        
        const keyEl = document.querySelector(`.piano-key[data-midi="${midi}"]`);
        if (keyEl) {
            keyEl.setAttribute('data-pressed', 'true');
        }
        playNote(midi);
    }
});

document.addEventListener('keyup', (e) => {
    if (e.code === 'Space') {
        e.preventDefault();
        setSustainPedal(false);
        return;
    }
    
    const midi = KEY_MAP[e.code];
    if (midi && activeKeyboardKeys.has(e.code)) {
        activeKeyboardKeys.delete(e.code);
        
        const keyEl = document.querySelector(`.piano-key[data-midi="${midi}"]`);
        if (keyEl) {
            keyEl.setAttribute('data-pressed', 'false');
        }
        stopNote(midi);
    }
});

// --- METRONOME PRECISION SCHEDULER ---
/**
 * Uses the standard Web Audio scheduler loop (highly accurate, no JS drift)
 */
function playMetronomeClick(time, beat) {
    if (!state.audioCtx) return;
    
    const osc = state.audioCtx.createOscillator();
    const gain = state.audioCtx.createGain();
    
    // High-pitched woodblock for first beat, lower for remaining beats
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(beat === 1 ? 1000 : 600, time);
    
    gain.gain.setValueAtTime(0, time);
    gain.gain.linearRampToValueAtTime(0.6, time + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.06); // short click
    
    osc.connect(gain);
    // Bypass reverb completely to ensure clean metronome cueing
    gain.connect(state.masterGain);
    
    osc.start(time);
    osc.stop(time + 0.08);
    
    // Sync UI Visual flashing with exact Audio trigger time
    const delayMs = Math.max(0, (time - state.audioCtx.currentTime) * 1000);
    setTimeout(() => {
        triggerMetronomeVisualFlash(beat);
    }, delayMs);
}

function triggerMetronomeVisualFlash(beat) {
    const visualDot = document.getElementById('metronome-visual');
    if (!visualDot) return;
    
    visualDot.className = 'tempo-indicator-dot';
    // Force DOM reflow
    void visualDot.offsetWidth;
    
    if (beat === 1) {
        visualDot.classList.add('pulse-accent');
    } else {
        visualDot.classList.add('pulse');
    }
}

function metronomeScheduler() {
    // Schedule all clicks within next lookahead interval
    while (state.nextNoteTime < state.audioCtx.currentTime + 0.1) {
        state.beatCount = (state.beatCount % 4) + 1; // 4/4 Beat Cycle
        playMetronomeClick(state.nextNoteTime, state.beatCount);
        
        // Calculate seconds per beat
        const secondsPerBeat = 60.0 / state.bpm;
        state.nextNoteTime += secondsPerBeat;
    }
    
    state.metronomeTimerId = setTimeout(metronomeScheduler, 25);
}

function toggleMetronome() {
    if (!state.audioCtx) initAudio();
    
    const btn = document.getElementById('btn-metronome-toggle');
    
    if (state.metronomeActive) {
        state.metronomeActive = false;
        clearTimeout(state.metronomeTimerId);
        btn.classList.remove('btn-primary');
        btn.classList.add('btn-outline');
        btn.textContent = '시작';
        document.getElementById('metronome-visual').className = 'tempo-indicator-dot';
    } else {
        state.metronomeActive = true;
        state.beatCount = 0;
        state.nextNoteTime = state.audioCtx.currentTime + 0.05;
        metronomeScheduler();
        btn.classList.remove('btn-outline');
        btn.classList.add('btn-primary');
        btn.textContent = '중지';
    }
}

// --- HIGH FIDELITY IN-MEMORY WAV RECORDER ---
/**
 * Captures pure PCM stereo stream directly from Web Audio node in real-time,
 * compiles a complete 16-bit uncompressed WAV file directly in-browser.
 */
function setupRecorder() {
    if (!state.audioCtx) return;
    
    // Create capturing node (ScriptProcessor is widely supported and robust for sample aggregation)
    // 4096 buffer size, 2 input channels, 2 output channels
    state.recorderNode = state.audioCtx.createScriptProcessor(4096, 2, 2);
    
    // Connect Synth output to the recording node so it captures notes + reverb
    state.synthOutput.connect(state.recorderNode);
    // Connect to master gain to keep routing, but set gain to 0 to avoid feedback
    const silentGain = state.audioCtx.createGain();
    silentGain.gain.value = 0.0;
    state.recorderNode.connect(silentGain);
    silentGain.connect(state.audioCtx.destination);
    
    state.recorderNode.onaudioprocess = function (audioProcessingEvent) {
        if (!state.isRecording) return;
        
        const inputBuffer = audioProcessingEvent.inputBuffer;
        const leftInput = inputBuffer.getChannelData(0);
        const rightInput = inputBuffer.getChannelData(1);
        
        // Collect float32 samples in chunks
        state.leftChannelBuffer.push(new Float32Array(leftInput));
        state.rightChannelBuffer.push(new Float32Array(rightInput));
        state.recordingLength += leftInput.length;
    };
}

function startRecording() {
    if (!state.audioCtx) initAudio();
    if (state.isRecording) return;
    
    state.leftChannelBuffer = [];
    state.rightChannelBuffer = [];
    state.recordingLength = 0;
    
    state.isRecording = true;
    state.recordingStartTime = state.audioCtx.currentTime;
    
    // Update UI elements
    const recDot = document.getElementById('rec-status-dot');
    recDot.className = 'rec-dot active';
    
    const recBtn = document.getElementById('btn-record-toggle');
    recBtn.className = 'btn btn-danger recording';
    document.getElementById('record-btn-text').textContent = '녹음 중지';
    
    document.getElementById('playback-container').style.display = 'none';
    
    // Start stopwatch
    updateRecordingTimer();
}

function stopRecording() {
    if (!state.isRecording) return;
    
    state.isRecording = false;
    clearTimeout(state.recordingTimerId);
    
    // Update UI
    const recDot = document.getElementById('rec-status-dot');
    recDot.className = 'rec-dot';
    
    const recBtn = document.getElementById('btn-record-toggle');
    recBtn.className = 'btn btn-danger';
    document.getElementById('record-btn-text').textContent = '녹음 시작';
    
    // Encode buffers into pure WAV file
    compileWavFile();
}

function updateRecordingTimer() {
    if (!state.isRecording) return;
    
    const elapsed = Math.floor(state.audioCtx.currentTime - state.recordingStartTime);
    const min = String(Math.floor(elapsed / 60)).padStart(2, '0');
    const sec = String(elapsed % 60).padStart(2, '0');
    
    document.getElementById('rec-time-display').textContent = `${min}:${sec}`;
    
    state.recordingTimerId = setTimeout(updateRecordingTimer, 1000);
}

/**
 * Packs float32 PCM samples into inter-leaved Int16 WAV format.
 */
function compileWavFile() {
    if (state.recordingLength === 0) return;
    
    // Flatten arrays
    const leftBuffer = mergeFloat32Arrays(state.leftChannelBuffer, state.recordingLength);
    const rightBuffer = mergeFloat32Arrays(state.rightChannelBuffer, state.recordingLength);
    
    // Interleave left and right channels for stereo WAV
    const interleaved = interleaveStereo(leftBuffer, rightBuffer);
    
    // Create standard WAV File ArrayBuffer
    const sampleRate = state.audioCtx.sampleRate;
    const wavBuffer = new ArrayBuffer(44 + interleaved.length * 2);
    const view = new DataView(wavBuffer);
    
    /* RIFF identifier */
    writeString(view, 0, 'RIFF');
    /* file length */
    view.setUint32(4, 36 + interleaved.length * 2, true);
    /* RIFF type */
    writeString(view, 8, 'WAVE');
    /* format chunk identifier */
    writeString(view, 12, 'fmt ');
    /* format chunk length */
    view.setUint32(16, 16, true);
    /* sample format (raw PCM = 1) */
    view.setUint16(20, 1, true);
    /* channel count (Stereo = 2) */
    view.setUint16(22, 2, true);
    /* sample rate */
    view.setUint32(24, sampleRate, true);
    /* byte rate (sample rate * block align) */
    view.setUint32(28, sampleRate * 4, true);
    /* block align (channel count * bytes per sample) */
    view.setUint16(32, 4, true);
    /* bits per sample (16-bit PCM) */
    view.setUint16(34, 16, true);
    /* data chunk identifier */
    writeString(view, 36, 'data');
    /* chunk length */
    view.setUint32(40, interleaved.length * 2, true);
    
    // Convert float32 [-1.0, 1.0] samples to signed 16-bit Int [-32768, 32767]
    let offset = 44;
    for (let i = 0; i < interleaved.length; i++, offset += 2) {
        let s = Math.max(-1, Math.min(1, interleaved[i]));
        // Scale to 16-bit signed integer
        view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    }
    
    // Pack binary WAV into a blob and load into audio tag
    const wavBlob = new Blob([view], { type: 'audio/wav' });
    const audioUrl = URL.createObjectURL(wavBlob);
    
    const audioPlayer = document.getElementById('recorded-audio');
    audioPlayer.src = audioUrl;
    
    const downloadBtn = document.getElementById('btn-download-record');
    downloadBtn.href = audioUrl;
    downloadBtn.download = `AuraPiano_수업연주_${new Date().toISOString().slice(0,10)}.wav`;
    
    // Display player card
    document.getElementById('playback-container').style.display = 'block';
}

function mergeFloat32Arrays(channelBuffer, totalLength) {
    const result = new Float32Array(totalLength);
    let offset = 0;
    for (let i = 0; i < channelBuffer.length; i++) {
        result.set(channelBuffer[i], offset);
        offset += channelBuffer[i].length;
    }
    return result;
}

function interleaveStereo(leftInput, rightInput) {
    const length = leftInput.length + rightInput.length;
    const result = new Float32Array(length);
    let index = 0;
    let inputIndex = 0;
    
    while (index < length) {
        result[index++] = leftInput[inputIndex];
        result[index++] = rightInput[inputIndex];
        inputIndex++;
    }
    return result;
}

function writeString(view, offset, string) {
    for (let i = 0; i < string.length; i++) {
        view.setUint8(offset + i, string.charCodeAt(i));
    }
}

// --- WIDGET UI EVENT BINDINGS & SYNCS ---
function setupUIListeners() {
    // 1. Presets Selector
    const presetButtons = document.querySelectorAll('.preset-btn');
    presetButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            presetButtons.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            state.currentPreset = btn.getAttribute('data-preset');
        });
    });
    
    // 2. Volume control
    const volSlider = document.getElementById('slider-volume');
    volSlider.addEventListener('input', (e) => {
        const val = parseInt(e.target.value);
        document.getElementById('val-volume').textContent = `${val}%`;
        
        if (state.audioCtx && state.masterGain) {
            // Apply volume scale smoothly
            const now = state.audioCtx.currentTime;
            state.masterGain.gain.setTargetAtTime((val / 100) * 0.9, now, 0.01);
        }
    });
    
    // 3. Reverb controls
    const wetSlider = document.getElementById('slider-reverb-wet');
    wetSlider.addEventListener('input', (e) => {
        const val = parseInt(e.target.value);
        document.getElementById('val-reverb-wet').textContent = `${val}%`;
        state.reverbWet = val / 100;
        updateReverbSettings();
    });
    
    const decaySlider = document.getElementById('slider-reverb-decay');
    decaySlider.addEventListener('input', (e) => {
        const val = parseFloat(e.target.value) / 10;
        document.getElementById('val-reverb-decay').textContent = `${val.toFixed(1)}초`;
        state.reverbDecay = val;
        updateReverbSettings();
    });
    
    // Reverb Preset Buttons
    const revPresetButtons = document.querySelectorAll('.rev-preset-btn');
    revPresetButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            revPresetButtons.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            
            const decay = parseFloat(btn.getAttribute('data-decay'));
            const wet = parseFloat(btn.getAttribute('data-wet'));
            
            // Sync values to sliders
            decaySlider.value = decay * 10;
            document.getElementById('val-reverb-decay').textContent = `${decay.toFixed(1)}초`;
            state.reverbDecay = decay;
            
            wetSlider.value = wet * 100;
            document.getElementById('val-reverb-wet').textContent = `${Math.round(wet * 100)}%`;
            state.reverbWet = wet;
            
            updateReverbSettings();
        });
    });
    
    // 4. Educational options
    const labelButtons = document.querySelectorAll('.segment-btn');
    labelButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            labelButtons.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            state.labelType = btn.getAttribute('data-label');
            renderKeyboard();
        });
    });
    
    // Keyboard hints toggle
    const hintSwitch = document.getElementById('chk-keyboard-hint');
    hintSwitch.addEventListener('change', (e) => {
        state.showKeyboardHints = e.target.checked;
        renderKeyboard();
    });
    
    // Sustain pedal screen button
    const sustainBtn = document.getElementById('btn-sustain');
    sustainBtn.addEventListener('mousedown', () => {
        setSustainPedal(!state.sustainPedalActive);
    });
    
    // 5. Metronome Controls
    document.getElementById('btn-metronome-toggle').addEventListener('click', toggleMetronome);
    
    const bpmSlider = document.getElementById('slider-bpm');
    const bpmValDisplay = document.getElementById('bpm-val');
    
    bpmSlider.addEventListener('input', (e) => {
        const val = parseInt(e.target.value);
        state.bpm = val;
        bpmValDisplay.textContent = val;
    });
    
    document.getElementById('btn-bpm-minus').addEventListener('click', () => {
        if (state.bpm > 40) {
            state.bpm--;
            bpmSlider.value = state.bpm;
            bpmValDisplay.textContent = state.bpm;
        }
    });
    
    document.getElementById('btn-bpm-plus').addEventListener('click', () => {
        if (state.bpm < 240) {
            state.bpm++;
            bpmSlider.value = state.bpm;
            bpmValDisplay.textContent = state.bpm;
        }
    });
    
    // 6. Record control button
    document.getElementById('btn-record-toggle').addEventListener('click', () => {
        if (state.isRecording) {
            stopRecording();
        } else {
            startRecording();
        }
    });
    
    // 7. Zoom keys controls
    const zoomInBtn = document.getElementById('btn-zoom-in');
    const zoomOutBtn = document.getElementById('btn-zoom-out');
    const zoomVal = document.getElementById('val-zoom');
    
    zoomInBtn.addEventListener('click', () => {
        if (state.zoomLevel < 150) {
            state.zoomLevel += 10;
            applyKeyboardZoom();
        }
    });
    
    zoomOutBtn.addEventListener('click', () => {
        if (state.zoomLevel > 60) {
            state.zoomLevel -= 10;
            applyKeyboardZoom();
        }
    });
    
    // Setup mouse wheel horizontal scrolling support in the piano key container
    const viewport = document.getElementById('piano-viewport');
    viewport.addEventListener('wheel', (e) => {
        if (e.deltaY !== 0) {
            e.preventDefault();
            viewport.scrollLeft += e.deltaY;
        }
    }, { passive: false });
}

function applyKeyboardZoom() {
    const zoomVal = document.getElementById('val-zoom');
    zoomVal.textContent = `${state.zoomLevel}%`;
    
    // Calculate new base key width in pixels
    const baseWidth = 52;
    const newWidth = Math.round((baseWidth * state.zoomLevel) / 100);
    
    const root = document.documentElement;
    root.style.setProperty('--key-width', `${newWidth}px`);
    
    // Force layout recalculations on keyboard
    renderKeyboard();
}

// --- INITIALIZE APPLICATION ON LOAD ---
window.addEventListener('DOMContentLoaded', () => {
    // Render the initial empty keyboard UI immediately so page looks premium on load
    renderKeyboard();
    
    // Set up listeners
    setupUIListeners();
    
    // Set initial custom zoom scale if mobile device
    if (window.innerWidth < 768) {
        state.zoomLevel = 70; // Smaller keys default on mobile
        applyKeyboardZoom();
    }
});
