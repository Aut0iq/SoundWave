# name=SoundWave
# url=https://github.com/Aut0iq/SoundWave
#
# MIDI controller script linking FL Studio with SoundWave (voice -> MIDI).
#
# - Notes from SoundWave pass through untouched and play/record on the selected channel.
# - Control changes on MIDI channel 16 drive FL's transport (record / play / stop).
# - FL reports tempo and play/record state back to SoundWave on the output port that has
#   the same port number as this input.
#
# Install: copy this folder to Documents\Image-Line\FL Studio\Settings\Hardware\SoundWave\
# (SoundWave does it for you), then in FL: Options > MIDI settings > Input "loopMIDI Port":
# Enable, Controller type "SoundWave (user)", Port 1; Output "loopMIDI Port": Port 1.

import device
import midi
import mixer
import transport

CTRL_CHANNEL = 15  # MIDI channel 16, zero-based

# SoundWave -> FL
CC_RECORD = 102  # arm recording and start playback
CC_PLAY = 103    # play / pause
CC_STOP = 104    # stop (and disarm recording)
CC_HELLO = 105   # request a full state report

# FL -> SoundWave
CC_TEMPO_MSB = 20  # tempo * 10, 14-bit
CC_TEMPO_LSB = 52
CC_PLAYING = 21
CC_RECORDING = 22
REPORTS = (CC_TEMPO_MSB, CC_TEMPO_LSB, CC_PLAYING, CC_RECORDING)

_last_state = None


def _send_cc(cc, value):
    try:
        device.midiOutMsg((0xB0 + CTRL_CHANNEL) + (cc << 8) + (value << 16))
    except Exception:
        pass  # no output port assigned: reporting is optional


def _tempo():
    try:
        t = float(mixer.getCurrentTempo())
        # Some FL versions report BPM * 1000.
        return t / 1000.0 if t > 1000 else t
    except Exception:
        return 0.0


def _state():
    try:
        playing = bool(transport.isPlaying())
    except Exception:
        playing = False
    try:
        recording = bool(transport.isRecording())
    except Exception:
        recording = False
    return (int(round(_tempo() * 10)), playing, recording)


def _report(force=False):
    global _last_state
    state = _state()
    if not force and state == _last_state:
        return
    _last_state = state
    t10 = max(0, min(16383, state[0]))
    _send_cc(CC_TEMPO_MSB, (t10 >> 7) & 127)
    _send_cc(CC_TEMPO_LSB, t10 & 127)
    _send_cc(CC_PLAYING, 127 if state[1] else 0)
    _send_cc(CC_RECORDING, 127 if state[2] else 0)


def _command(cc):
    if cc == CC_RECORD:
        if not transport.isRecording():
            transport.record()
        if not transport.isPlaying():
            transport.start()
    elif cc == CC_PLAY:
        transport.start()
    elif cc == CC_STOP:
        transport.stop()
        if transport.isRecording():
            transport.record()
    _report(True)


def OnInit():
    _report(True)


def OnDeInit():
    pass


def OnIdle():
    _report()


def OnRefresh(flags):
    _report()


def OnUpdateBeatIndicator(value):
    _report()


def OnMidiMsg(event):
    status = event.status
    if (status & 0xF0) != midi.MIDI_CONTROLCHANGE or (status & 0x0F) != CTRL_CHANNEL:
        event.handled = False  # notes and everything else go to FL as usual
        return
    cc = event.data1
    if cc in REPORTS:
        event.handled = True  # our own reports echoed back by a shared loopMIDI port
        return
    if cc in (CC_RECORD, CC_PLAY, CC_STOP, CC_HELLO):
        event.handled = True
        if event.data2 > 0:
            if cc == CC_HELLO:
                _report(True)
            else:
                _command(cc)
        return
    event.handled = False
