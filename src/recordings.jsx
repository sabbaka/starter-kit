/*
 * This file is part of Cockpit.
 *
 * Copyright (C) 2017 Red Hat, Inc.
 *
 * Cockpit is free software; you can redistribute it and/or modify it
 * under the terms of the GNU Lesser General Public License as published by
 * the Free Software Foundation; either version 2.1 of the License, or
 * (at your option) any later version.
 *
 * Cockpit is distributed in the hope that it will be useful, but
 * WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * Lesser General Public License for more details.
 *
 * You should have received a copy of the GNU Lesser General Public License
 * along with Cockpit; If not, see <http://www.gnu.org/licenses/>.
 */
"use strict";

import React from "react";
import ReactDOM from "react-dom";

let $ = require("jquery");
let cockpit = require("cockpit");
let _ = cockpit.gettext;
let moment = require("moment");
let Journal = require("journal");
let Listing = require("cockpit-components-listing.jsx");
let Term = require("term.js-cockpit");
// let Player = require("./player.jsx");

require("console.css");
require("bootstrap-slider");
require("bootstrap-datetime-picker/js/bootstrap-datetimepicker.js");
require("bootstrap-datetime-picker/css/bootstrap-datetimepicker.css");

/*
 * Convert a number to integer number string and pad with zeroes to
 * specified width.
 */
let padInt = function (n, w) {
    let i = Math.floor(n);
    let a = Math.abs(i);
    let s = a.toString();
    for (w -= s.length; w > 0; w--) {
        s = '0' + s;
    }
    return ((i < 0) ? '-' : '') + s;
};

/*
 * Format date and time for a number of milliseconds since Epoch.
 */
let formatDateTime = function (ms) {
    return moment(ms).format("YYYY-MM-DD HH:mm:ss");
};

let formatDateTimeOffset = function (ms, offset) {
    return moment(ms).utcOffset(offset)
            .format("YYYY-MM-DD HH:mm:ss");
};

/*
 * Format a time interval from a number of milliseconds.
 */
let formatDuration = function (ms) {
    let v = Math.floor(ms / 1000);
    let s = Math.floor(v % 60);
    v = Math.floor(v / 60);
    let m = Math.floor(v % 60);
    v = Math.floor(v / 60);
    let h = Math.floor(v % 24);
    let d = Math.floor(v / 24);
    let str = '';

    if (d > 0) {
        str += d + ' ' + _("days") + ' ';
    }

    if (h > 0 || str.length > 0) {
        str += padInt(h, 2) + ':';
    }

    str += padInt(m, 2) + ':' + padInt(s, 2);

    return (ms < 0 ? '-' : '') + str;
};

let scrollToBottom = function(id) {
    const el = document.getElementById(id);
    if (el) {
        el.scrollTop = el.scrollHeight;
    }
};

let parseDate = function(date) {
    let regex = new RegExp(/^\s*(\d\d\d\d-\d\d-\d\d)(\s+(\d\d:\d\d(:\d\d)?))?\s*$/);

    let captures = regex.exec(date);

    if (captures != null) {
        let date = captures[1];
        if (captures[3]) {
            date = date + " " + captures[3];
        }
        if (moment(date, ["YYYY-M-D H:m:s", "YYYY-M-D H:m", "YYYY-M-D"], true).isValid()) {
            return date;
        }
    }

    if (date === "" || date === null) {
        return true;
    }

    return false;
};

function ErrorList(props) {
    let list = [];

    if (props.list) {
        list = props.list.map((message, key) => { return <ErrorItem key={key} message={message} /> });
    }

    return (
        <React.Fragment>
            {list}
        </React.Fragment>
    );
}

function ErrorItem(props) {
    return (
        <div className="alert alert-danger alert-dismissable" >
            <button type="button" className="close" data-dismiss="alert" aria-hidden="true">
                <span className="pficon pficon-close" />
            </button>
            <span className="pficon pficon-error-circle-o" />
            {props.message}
        </div>
    );
}

let ErrorService = class {
    constructor() {
        this.addMessage = this.addMessage.bind(this);
        this.errors = [];
    }

    addMessage(message) {
        if (typeof message === "object" && message !== null) {
            if ("toString" in message) {
                message = message.toString();
            } else {
                message = _("unknown error");
            }
        }
        if (typeof message === "string" || message instanceof String) {
            if (this.errors.indexOf(message) === -1) {
                this.errors.push(message);
            }
        }
    }
};

/*
 * An auto-loading buffer of recording's packets.
 */
let PacketBuffer = class {
    /*
     * Initialize a buffer.
     */
    constructor(matchList, reportError) {
        this.handleError = this.handleError.bind(this);
        this.handleStream = this.handleStream.bind(this);
        this.handleDone = this.handleDone.bind(this);
        this.getValidField = this.getValidField.bind(this);
        /* RegExp used to parse message's timing field */
        this.timingRE = new RegExp(
            /* Delay (1) */
            "\\+(\\d+)|" +
            /* Text input (2) */
            "<(\\d+)|" +
            /* Binary input (3, 4) */
            "\\[(\\d+)/(\\d+)|" +
            /* Text output (5) */
            ">(\\d+)|" +
            /* Binary output (6, 7) */
            "\\](\\d+)/(\\d+)|" +
            /* Window (8, 9) */
            "=(\\d+)x(\\d+)|" +
            /* End of string */
            "$",
            /* Continue after the last match only */
            /* FIXME Support likely sparse */
            "y"
        );
        /* List of matches to apply when loading the buffer from Journal */
        this.matchList = matchList;
        this.reportError = reportError;
        /*
         * An array of two-element arrays (tuples) each containing a
         * packet index and a deferred object. The list is kept sorted to
         * have tuples with lower packet indices first. Once the buffer
         * receives a packet at the specified index, the matching tuple is
         * removed from the list, and its deferred object is resolved.
         * This is used to keep users informed about packets arriving.
         */
        this.idxDfdList = [];
        /* Last seen message ID */
        this.id = 0;
        /* Last seen time position */
        this.pos = 0;
        /* Last seen window width */
        this.width = null;
        /* Last seen window height */
        this.height = null;
        /* List of packets read */
        this.pktList = [];
        /* Error which stopped the loading */
        this.error = null;
        /* The journalctl reading the recording */
        this.journalctl = Journal.journalctl(
            this.matchList,
            {count: "all", follow: false, merge: true});
        this.journalctl.fail(this.handleError);
        this.journalctl.stream(this.handleStream);
        this.journalctl.done(this.handleDone);
        /*
         * Last seen cursor of the first, non-follow, journalctl run.
         * Null if no entry was received yet, or the second run has
         * skipped the entry received last by the first run.
         */
        this.cursor = null;
        /* True if the first, non-follow, journalctl run has completed */
        this.done = false;
    }

    /*
     * Get an object field, verifying its presence and type.
     */
    getValidField(object, field, type) {
        let value;
        if (!(field in object)) {
            this.reportError("\"" + field + "\" field is missing");
        }
        value = object[field];
        if (typeof (value) !== typeof (type)) {
            this.reportError("invalid \"" + field + "\" field type: " + typeof (value));
        }
        return value;
    }

    /*
     * Return a promise which is resolved when a packet at a particular
     * index is received by the buffer. The promise is rejected with a
     * non-null argument if an error occurs or has occurred previously.
     * The promise is rejected with null, when the buffer is stopped. If
     * the packet index is not specified, assume it's the next packet.
     */
    awaitPacket(idx) {
        let i;
        let idxDfd;

        /* If an error has occurred previously */
        if (this.error !== null) {
            /* Reject immediately */
            return $.Deferred().reject(this.error)
                    .promise();
        }

        /* If the buffer was stopped */
        if (this.journalctl === null) {
            return $.Deferred().reject(null)
                    .promise();
        }

        /* If packet index is not specified */
        if (idx === undefined) {
            /* Assume it's the next one */
            idx = this.pktList.length;
        } else {
            /* If it has already been received */
            if (idx < this.pktList.length) {
                /* Return resolved promise */
                return $.Deferred().resolve()
                        .promise();
            }
        }

        /* Try to find an existing, matching tuple */
        for (i = 0; i < this.idxDfdList.length; i++) {
            idxDfd = this.idxDfdList[i];
            if (idxDfd[0] === idx) {
                return idxDfd[1].promise();
            } else if (idxDfd[0] > idx) {
                break;
            }
        }

        /* Not found, create and insert a new tuple */
        idxDfd = [idx, $.Deferred()];
        this.idxDfdList.splice(i, 0, idxDfd);

        /* Return its promise */
        return idxDfd[1].promise();
    }

    /*
     * Return true if the buffer was done loading everything logged to
     * journal so far and is now waiting for and loading new entries.
     * Return false if the buffer is loading existing entries so far.
     */
    isDone() {
        return this.done;
    }

    /*
     * Stop receiving the entries
     */
    stop() {
        if (this.journalctl === null) {
            return;
        }
        /* Destroy journalctl */
        this.journalctl.stop();
        this.journalctl = null;
        /* Notify everyone we stopped */
        for (let i = 0; i < this.idxDfdList.length; i++) {
            this.idxDfdList[i][1].reject(null);
        }
        this.idxDfdList = [];
    }

    /*
     * Add a packet to the received packet list.
     */
    addPacket(pkt) {
        /* TODO Validate the packet */
        /* Add the packet */
        this.pktList.push(pkt);
        /* Notify any matching listeners */
        while (this.idxDfdList.length > 0) {
            let idxDfd = this.idxDfdList[0];
            if (idxDfd[0] < this.pktList.length) {
                this.idxDfdList.shift();
                idxDfd[1].resolve();
            } else {
                break;
            }
        }
    }

    /*
     * Handle an error.
     */
    handleError(error) {
        /* Remember the error */
        this.error = error;
        /* Destroy journalctl, don't try to recover */
        if (this.journalctl !== null) {
            this.journalctl.stop();
            this.journalctl = null;
        }
        /* Notify everyone we had an error */
        for (let i = 0; i < this.idxDfdList.length; i++) {
            this.idxDfdList[i][1].reject(error);
        }
        this.idxDfdList = [];
        this.reportError(error);
    }

    /*
     * Parse packets out of a tlog message data and add them to the buffer.
     */
    parseMessageData(timing, in_txt, out_txt) {
        let matches;
        let in_txt_pos = 0;
        let out_txt_pos = 0;
        let t;
        let x;
        let y;
        let s;
        let io = [];
        let is_output;

        /* While matching entries in timing */
        this.timingRE.lastIndex = 0;
        for (;;) {
            /* Match next timing entry */
            matches = this.timingRE.exec(timing);
            if (matches === null) {
                this.reportError(_("invalid timing string"));
            } else if (matches[0] === "") {
                break;
            }

            /* Switch on entry type character */
            switch (t = matches[0][0]) {
            /* Delay */
            case "+":
                x = parseInt(matches[1], 10);
                if (x === 0) {
                    break;
                }
                if (io.length > 0) {
                    this.addPacket({pos: this.pos,
                                    is_io: true,
                                    is_output: is_output,
                                    io: io.join()});
                    io = [];
                }
                this.pos += x;
                break;
                /* Text or binary input */
            case "<":
            case "[":
                x = parseInt(matches[(t === "<") ? 2 : 3], 10);
                if (x === 0) {
                    break;
                }
                if (io.length > 0 && is_output) {
                    this.addPacket({pos: this.pos,
                                    is_io: true,
                                    is_output: is_output,
                                    io: io.join()});
                    io = [];
                }
                is_output = false;
                /* Add (replacement) input characters */
                s = in_txt.slice(in_txt_pos, in_txt_pos += x);
                if (s.length !== x) {
                    this.reportError(_("timing entry out of input bounds"));
                }
                io.push(s);
                break;
                /* Text or binary output */
            case ">":
            case "]":
                x = parseInt(matches[(t === ">") ? 5 : 6], 10);
                if (x === 0) {
                    break;
                }
                if (io.length > 0 && !is_output) {
                    this.addPacket({pos: this.pos,
                                    is_io: true,
                                    is_output: is_output,
                                    io: io.join()});
                    io = [];
                }
                is_output = true;
                /* Add (replacement) output characters */
                s = out_txt.slice(out_txt_pos, out_txt_pos += x);
                if (s.length !== x) {
                    this.reportError(_("timing entry out of output bounds"));
                }
                io.push(s);
                break;
                /* Window */
            case "=":
                x = parseInt(matches[8], 10);
                y = parseInt(matches[9], 10);
                if (x === this.width && y === this.height) {
                    break;
                }
                if (io.length > 0) {
                    this.addPacket({pos: this.pos,
                                    is_io: true,
                                    is_output: is_output,
                                    io: io.join()});
                    io = [];
                }
                this.addPacket({pos: this.pos,
                                is_io: false,
                                width: x,
                                height: y});
                this.width = x;
                this.height = y;
                break;
            }
        }

        if (in_txt_pos < in_txt.length) {
            this.reportError(_("extra input present"));
        }
        if (out_txt_pos < out_txt.length) {
            this.reportError(_("extra output present"));
        }

        if (io.length > 0) {
            this.addPacket({pos: this.pos,
                            is_io: true,
                            is_output: is_output,
                            io: io.join()});
        }
    }

    /*
     * Parse packets out of a tlog message and add them to the buffer.
     */
    parseMessage(message) {
        let matches;
        let ver;
        let id;
        let pos;

        const number = Number();
        const string = String();

        /* Check version */
        ver = this.getValidField(message, "ver", string);
        matches = ver.match("^(\\d+)\\.(\\d+)$");
        if (matches === null || matches[1] > 2) {
            this.reportError("\"ver\" field has invalid value: " + ver);
        }

        /* TODO Perhaps check host, rec, user, term, and session fields */

        /* Extract message ID */
        id = this.getValidField(message, "id", number);
        if (id <= this.id) {
            this.reportError("out of order \"id\" field value: " + id);
        }

        /* Extract message time position */
        pos = this.getValidField(message, "pos", number);
        if (pos < this.message_pos) {
            this.reportError("out of order \"pos\" field value: " + pos);
        }

        /* Update last received message ID and time position */
        this.id = id;
        this.pos = pos;

        /* Parse message data */
        this.parseMessageData(
            this.getValidField(message, "timing", string),
            this.getValidField(message, "in_txt", string),
            this.getValidField(message, "out_txt", string));
    }

    /*
     * Handle journalctl "stream" event.
     */
    handleStream(entryList) {
        let i;
        let e;
        for (i = 0; i < entryList.length; i++) {
            e = entryList[i];
            /* If this is the second, "follow", run */
            if (this.done) {
                /* Skip the last entry we added on the first run */
                if (this.cursor !== null) {
                    this.cursor = null;
                    continue;
                }
            } else {
                if (!('__CURSOR' in e)) {
                    this.handleError("No cursor in a Journal entry");
                }
                this.cursor = e['__CURSOR'];
            }
            /* TODO Refer to entry number/cursor in errors */
            if (!('MESSAGE' in e)) {
                this.handleError("No message in Journal entry");
            }
            /* Parse the entry message */
            try {
                this.parseMessage(JSON.parse(e['MESSAGE']));
            } catch (error) {
                this.handleError(error);
                return;
            }
        }
    }

    /*
     * Handle journalctl "done" event.
     */
    handleDone() {
        this.done = true;
        if (this.journalctl !== null) {
            this.journalctl.stop();
            this.journalctl = null;
        }
        /* Continue with the "following" run  */
        this.journalctl = Journal.journalctl(
            this.matchList,
            {cursor: this.cursor,
             follow: true, merge: true, count: "all"});
        this.journalctl.fail(this.handleError);
        this.journalctl.stream(this.handleStream);
        /* NOTE: no "done" handler on purpose */
    }
};

class Slider extends React.Component {
    constructor(props) {
        super(props);
        this.slideStart = this.slideStart.bind(this);
        this.slideStop = this.slideStop.bind(this);
        this.slider = null;
        this.state = {
            paused: false,
        };
    }

    slideStart(e) {
        this.setState({paused: this.props.paused});
        this.props.pause();
    }

    slideStop(e) {
        if (this.props.fastForwardFunc) {
            this.props.fastForwardFunc(e);
            if (this.state.paused === false) {
                this.props.play();
            }
        }
    }

    componentDidMount() {
        this.slider = $("#slider").slider({
            value: 0,
            tooltip: "hide",
            enabled: false,
        });
        this.slider.slider('on', 'slideStart', this.slideStart);
        this.slider.slider('on', 'slideStop', this.slideStop);
    }

    componentDidUpdate() {
        if (this.props.length) {
            this.slider.slider('enable');
            this.slider.slider('setAttribute', 'max', this.props.length);
        }
        if (this.props.mark) {
            this.slider.slider('setValue', this.props.mark);
        }
    }

    render () {
        return (
            <input id="slider" type="text" />
        );
    }
}

function SearchEntry(props) {
    return (
        <span className="search-result"><a onClick={(e) => props.fastForwardToTS(props.pos, e)}>{formatDuration(props.pos)}</a></span>
    );
}

class Search extends React.Component {
    constructor(props) {
        super(props);
        this.handleInputChange = this.handleInputChange.bind(this);
        this.handleStream = this.handleStream.bind(this);
        this.handleError = this.handleError.bind(this);
        this.handleSearchSubmit = this.handleSearchSubmit.bind(this);
        this.clearSearchResults = this.clearSearchResults.bind(this);
        this.state = {
            search: cockpit.location.options.search_rec || cockpit.location.options.search || "",
        };
    }

    handleInputChange(event) {
        event.preventDefault();
        const name = event.target.name;
        const value = event.target.value;
        let state = {};
        state[name] = value;
        this.setState(state);
        cockpit.location.go(cockpit.location.path[0], $.extend(cockpit.location.options, {search_rec: value}));
    }

    handleSearchSubmit() {
        this.journalctl = Journal.journalctl(
            this.props.matchList,
            {count: "all", follow: false, merge: true, grep: this.state.search});
        this.journalctl.fail(this.handleError);
        this.journalctl.stream(this.handleStream);
    }

    handleStream(data) {
        let items = data.map(item => {
            return JSON.parse(item.MESSAGE);
        });
        items = items.map(item => {
            return <SearchEntry key={item.id} fastForwardToTS={this.props.fastForwardToTS} pos={item.pos} />;
        });
        this.setState({items: items});
    }

    handleError(data) {
        this.props.errorService.addMessage(data);
    }

    clearSearchResults() {
        delete cockpit.location.options.search;
        cockpit.location.go(cockpit.location.path[0], cockpit.location.options);
        this.setState({search: ""});
        this.handleStream([]);
    }

    componentDidMount() {
        if (this.state.search) {
            this.handleSearchSubmit();
        }
    }

    render() {
        return (
            <div className="search-wrap">
                <div className="input-group search-component">
                    <input type="text" className="form-control" name="search" value={this.state.search} onChange={this.handleInputChange} />
                    <span className="input-group-btn">
                        <button className="btn btn-default" onClick={this.handleSearchSubmit}><span className="glyphicon glyphicon-search" /></button>
                        <button className="btn btn-default" onClick={this.clearSearchResults}><span className="glyphicon glyphicon-remove" /></button>
                    </span>
                </div>
                <div className="search-results">
                    {this.state.items}
                </div>
            </div>
        );
    }
}

class InputPlayer extends React.Component {
    render() {
        const input = String(this.props.input).replace(/(?:\r\n|\r|\n)/g, " ");

        return (
            <textarea name="input" id="input-textarea" cols="30" rows="1" value={input} readOnly disabled />
        );
    }
}

class Player extends React.Component {
    constructor(props) {
        super(props);
        this.handleTimeout = this.handleTimeout.bind(this);
        this.handlePacket = this.handlePacket.bind(this);
        this.handleError = this.handleError.bind(this);
        this.handleTitleChange = this.handleTitleChange.bind(this);
        this.rewindToStart = this.rewindToStart.bind(this);
        this.playPauseToggle = this.playPauseToggle.bind(this);
        this.play = this.play.bind(this);
        this.pause = this.pause.bind(this);
        this.speedUp = this.speedUp.bind(this);
        this.speedDown = this.speedDown.bind(this);
        this.speedReset = this.speedReset.bind(this);
        this.fastForwardToEnd = this.fastForwardToEnd.bind(this);
        this.skipFrame = this.skipFrame.bind(this);
        this.handleKeyDown = this.handleKeyDown.bind(this);
        this.sync = this.sync.bind(this);
        this.zoomIn = this.zoomIn.bind(this);
        this.zoomOut = this.zoomOut.bind(this);
        this.fitTo = this.fitTo.bind(this);
        this.dragPan = this.dragPan.bind(this);
        this.dragPanEnable = this.dragPanEnable.bind(this);
        this.dragPanDisable = this.dragPanDisable.bind(this);
        this.zoom = this.zoom.bind(this);
        this.fastForwardToTS = this.fastForwardToTS.bind(this);
        this.sendInput = this.sendInput.bind(this);
        this.clearInputPlayer = this.clearInputPlayer.bind(this);

        this.state = {
            cols:               80,
            rows:               25,
            title:              _("Player"),
            term:               null,
            paused:             true,
            /* Speed exponent */
            speedExp:           0,
            container_width:    630,
            scale_initial:      1,
            scale_lock:         false,
            term_top_style:     "50%",
            term_left_style:    "50%",
            term_translate:     "-50%, -50%",
            term_scroll:        "hidden",
            term_zoom_max:      false,
            term_zoom_min:      false,
            drag_pan:           false,
            containerWidth: 630,
            currentTsPost:  0,
            scale:          1,
            input:          "",
            mark:           0,
            logsTs:         null,
        };

        this.containerHeight = 290;

        /* Auto-loading buffer of recording's packets */
        this.error_service = new ErrorService();
        this.reportError = this.error_service.addMessage;
        this.buf = new PacketBuffer(this.props.matchList, this.reportError);

        /* Current recording time, ms */
        this.recTS = 0;
        /* Corresponding local time, ms */
        this.locTS = 0;

        /* Index of the current packet */
        this.pktIdx = 0;
        /* Current packet, or null if not retrieved */
        this.pkt = null;
        /* Timeout ID of the current packet, null if none */
        this.timeout = null;

        /* True if the next packet should be output without delay */
        this.skip = false;
        /* Playback speed */
        this.speed = 1;
        /*
         * Timestamp playback should fast-forward to.
         * Recording time, ms, or null if not fast-forwarding.
         */
        this.fastForwardTo = null;
    }

    reset() {
        /* Clear any pending timeouts */
        this.clearTimeout();

        /* Reset the terminal */
        this.state.term.reset();

        /* Move to beginning of buffer */
        this.pktIdx = 0;
        /* No packet loaded */
        this.pkt = null;

        /* We are not skipping */
        this.skip = false;
        /* We are not fast-forwarding */
        this.fastForwardTo = null;

        /* Move to beginning of recording */
        this.recTS = 0;
        this.setState({currentTsPost: parseInt(this.recTS)});
        /* Start the playback time */
        this.locTS = performance.now();

        /* Wait for the first packet */
        this.awaitPacket(0);
    }

    /* Subscribe for a packet at specified index */
    awaitPacket(idx) {
        this.buf.awaitPacket(idx).done(this.handlePacket)
                .fail(this.handleError);
    }

    /* Set next packet timeout, ms */
    setTimeout(ms) {
        this.timeout = window.setTimeout(this.handleTimeout, ms);
    }

    /* Clear next packet timeout */
    clearTimeout() {
        if (this.timeout !== null) {
            window.clearTimeout(this.timeout);
            this.timeout = null;
        }
    }

    /* Handle packet retrieval error */
    handleError(error) {
        if (error !== null) {
            this.reportError(error);
            console.warn(error);
        }
    }

    /* Handle packet retrieval success */
    handlePacket() {
        this.sync();
    }

    /* Handle arrival of packet output time */
    handleTimeout() {
        this.timeout = null;
        this.sync();
    }

    /* Handle terminal title change */
    handleTitleChange(title) {
        this.setState({ title: _("Player") + ": " + title });
    }

    _transform(width, height) {
        let relation = Math.min(
            this.state.containerWidth / this.state.term.element.offsetWidth,
            this.containerHeight / this.state.term.element.offsetHeight
        );
        this.setState({
            term_top_style: "50%",
            term_left_style: "50%",
            term_translate: "-50%, -50%",
            scale: relation,
            scale_initial: relation,
            cols: width,
            rows: height
        });
    }

    sendInput(pkt) {
        if (pkt) {
            const current_input = this.state.input;
            this.setState({input: current_input + pkt.io});
        }
    }

    /* Synchronize playback */
    sync() {
        let locDelay;

        /* We are already called, don't call us with timeout */
        this.clearTimeout();

        /* Forever */
        for (;;) {
            /* Get another packet to output, if none */
            for (; this.pkt === null; this.pktIdx++) {
                let pkt = this.buf.pktList[this.pktIdx];
                /* If there are no more packets */
                if (pkt === undefined) {
                    /*
                     * If we're done loading existing packets and we were
                     * fast-forwarding.
                     */
                    if (this.fastForwardTo != null && this.buf.isDone()) {
                        /* Stop fast-forwarding */
                        this.fastForwardTo = null;
                    }
                    /* Call us when we get one */
                    this.awaitPacket();
                    return;
                }

                this.pkt = pkt;
            }

            /* Get the current local time */
            let nowLocTS = performance.now();

            /* Ignore the passed time, if we're paused */
            if (this.state.paused) {
                locDelay = 0;
            } else {
                locDelay = nowLocTS - this.locTS;
            }

            /* Sync to the local time */
            this.locTS = nowLocTS;

            /* If we are skipping one packet's delay */
            if (this.skip) {
                this.skip = false;
                this.recTS = this.pkt.pos;
                /* Else, if we are fast-forwarding */
            } else if (this.fastForwardTo !== null) {
                /* If we haven't reached fast-forward destination */
                if (this.pkt.pos < this.fastForwardTo) {
                    this.recTS = this.pkt.pos;
                } else {
                    this.recTS = this.fastForwardTo;
                    this.fastForwardTo = null;
                    continue;
                }
                /* Else, if we are paused */
            } else if (this.state.paused) {
                return;
            } else {
                this.recTS += locDelay * this.speed;
                let pktRecDelay = this.pkt.pos - this.recTS;
                let pktLocDelay = pktRecDelay / this.speed;
                this.setState({currentTsPost: parseInt(this.recTS)});
                /* If we're more than 5 ms early for this packet */
                if (pktLocDelay > 5) {
                    /* Call us again on time, later */
                    this.setTimeout(pktLocDelay);
                    return;
                }
            }

            /* Send packet ts to the top */
            // this.props.onTsChange(this.pkt.pos);
            this.setState({currentTsPost: parseInt(this.pkt.pos)});

            /* Output the packet */
            if (this.pkt.is_io && !this.pkt.is_output) {
                this.sendInput(this.pkt);
            } else if (this.pkt.is_io) {
                this.state.term.write(this.pkt.io);
            } else {
                this.state.term.resize(this.pkt.width, this.pkt.height);
                if (!this.state.scale_lock) {
                    this._transform(this.pkt.width, this.pkt.height);
                }
            }

            /* We no longer have a packet */
            this.pkt = null;
        }
    }

    playPauseToggle() {
        this.setState({paused: !this.state.paused});
    }

    play() {
        this.setState({paused: false});
    }

    pause() {
        this.setState({paused: true});
    }

    speedUp() {
        let speedExp = this.state.speedExp;
        if (speedExp < 4) {
            this.setState({speedExp: speedExp + 1});
        }
    }

    speedDown() {
        let speedExp = this.state.speedExp;
        if (speedExp > -4) {
            this.setState({speedExp: speedExp - 1});
        }
    }

    speedReset() {
        this.setState({speedExp: 0});
    }

    clearInputPlayer() {
        this.setState({input: ""});
    }

    rewindToStart() {
        this.clearInputPlayer();
        this.reset();
        this.sync();
    }

    fastForwardToEnd() {
        this.fastForwardTo = Infinity;
        this.sync();
    }

    fastForwardToTS(ts) {
        if (ts < this.recTS) {
            this.reset();
        }
        this.fastForwardTo = ts;
        this.sync();
    }

    skipFrame() {
        this.skip = true;
        this.sync();
    }

    handleKeyDown(event) {
        let keyCodesFuncs = {
            "P": this.playPauseToggle,
            "}": this.speedUp,
            "{": this.speedDown,
            "Backspace": this.speedReset,
            ".": this.skipFrame,
            "G": this.fastForwardToEnd,
            "R": this.rewindToStart,
            "+": this.zoomIn,
            "=": this.zoomIn,
            "-": this.zoomOut,
            "Z": this.fitIn,
        };
        if (event.target.nodeName.toLowerCase() !== 'input') {
            if (keyCodesFuncs[event.key]) {
                (keyCodesFuncs[event.key](event));
            }
        }
    }

    zoom(scale) {
        if (scale.toFixed(6) === this.state.scale_initial.toFixed(6)) {
            this.fitTo();
        } else {
            this.setState({
                term_top_style: "0",
                term_left_style: "0",
                term_translate: "0, 0",
                scale_lock: true,
                term_scroll: "auto",
                scale: scale,
                term_zoom_max: false,
                term_zoom_min: false,
            });
        }
    }

    dragPan() {
        (this.state.drag_pan ? this.dragPanDisable() : this.dragPanEnable());
    }

    dragPanEnable() {
        this.setState({drag_pan: true});

        let scrollwrap = this.refs.scrollwrap;

        let clicked = false;
        let clickX;
        let clickY;

        $(this.refs.scrollwrap).on({
            'mousemove': function(e) {
                clicked && updateScrollPos(e);
            },
            'mousedown': function(e) {
                clicked = true;
                clickY = e.pageY;
                clickX = e.pageX;
            },
            'mouseup': function() {
                clicked = false;
                $('html').css('cursor', 'auto');
            }
        });

        let updateScrollPos = function(e) {
            $('html').css('cursor', 'move');
            $(scrollwrap).scrollTop($(scrollwrap).scrollTop() + (clickY - e.pageY));
            $(scrollwrap).scrollLeft($(scrollwrap).scrollLeft() + (clickX - e.pageX));
        };
    }

    dragPanDisable() {
        this.setState({drag_pan: false});
        let scrollwrap = this.refs.scrollwrap;
        $(scrollwrap).off("mousemove");
        $(scrollwrap).off("mousedown");
        $(scrollwrap).off("mouseup");
    }

    zoomIn() {
        let scale = this.state.scale;
        if (scale < 2.1) {
            scale = scale + 0.1;
            this.zoom(scale);
        } else {
            this.setState({term_zoom_max: true});
        }
    }

    zoomOut() {
        let scale = this.state.scale;
        if (scale >= 0.2) {
            scale = scale - 0.1;
            this.zoom(scale);
        } else {
            this.setState({term_zoom_min: true});
        }
    }

    fitTo() {
        this.setState({
            term_top_style: "50%",
            term_left_style: "50%",
            term_translate: "-50%, -50%",
            scale_lock: false,
            term_scroll: "hidden",
        });
        this._transform();
    }

    componentWillMount() {
        let term = new Term({
            cols: this.state.cols,
            rows: this.state.rows,
            screenKeys: true,
            useStyle: true
        });

        term.on('title', this.handleTitleChange);

        this.setState({ term: term });

        window.addEventListener("keydown", this.handleKeyDown, false);
    }

    componentDidMount() {
        if (this.refs.wrapper.offsetWidth) {
            this.setState({containerWidth: this.refs.wrapper.offsetWidth});
        }
        /* Open the terminal */
        this.state.term.open(this.refs.term);
        window.setInterval(this.sync, 100);
        /* Reset playback */
        this.reset();
        this.fastForwardToTS(0);
    }

    componentWillUpdate(nextProps, nextState) {
        /* If we changed pause state or speed exponent */
        if (nextState.paused !== this.state.paused ||
            nextState.speedExp !== this.state.speedExp) {
            this.sync();
        }
    }

    componentDidUpdate(prevProps, prevState) {
        /* If we changed pause state or speed exponent */
        if (this.state.paused !== prevState.paused ||
            this.state.speedExp !== prevState.speedExp) {
            this.speed = Math.pow(2, this.state.speedExp);
            this.sync();
        }
        if (this.state.input !== prevState.input) {
            scrollToBottom("input-textarea");
        }
        if (prevState.logsTs !== this.state.logsTs) {
            this.fastForwardToTS(this.state.logsTs);
        }
    }

    render() {
        let r = this.props.recording;

        let speedExp = this.state.speedExp;
        let speedFactor = Math.pow(2, Math.abs(speedExp));
        let speedStr;

        if (speedExp > 0) {
            speedStr = "x" + speedFactor;
        } else if (speedExp < 0) {
            speedStr = "/" + speedFactor;
        } else {
            speedStr = "";
        }

        const style = {
            "transform": "scale(" + this.state.scale + ") translate(" + this.state.term_translate + ")",
            "transformOrigin": "top left",
            "display": "inline-block",
            "margin": "0 auto",
            "position": "absolute",
            "top": this.state.term_top_style,
            "left": this.state.term_left_style,
        };

        const scrollwrap = {
            "minWidth": "630px",
            "height": this.containerHeight + "px",
            "backgroundColor": "#f5f5f5",
            "overflow": this.state.term_scroll,
            "position": "relative",
        };

        const to_right = {
            "float": "right",
        };

        // ensure react never reuses this div by keying it with the terminal widget
        return (
            <React.Fragment>
                <div className="row">
                    <div id="recording-wrap">
                        <div className="col-md-6 player-wrap">
                            <div ref="wrapper" className="panel panel-default">
                                <div className="panel-heading">
                                    <span>{this.state.title}</span>
                                </div>
                                <div className="panel-body">
                                    <div className={(this.state.drag_pan ? "dragnpan" : "")} style={scrollwrap} ref="scrollwrap">
                                        <div ref="term" className="console-ct" key={this.state.term} style={style} />
                                    </div>
                                </div>
                                <div className="panel-footer">
                                    <Slider length={this.buf.pos} mark={this.state.currentTsPost} fastForwardFunc={this.fastForwardToTS} play={this.play} pause={this.pause} paused={this.state.paused} />
                                    <button title="Play/Pause - Hotkey: p" type="button" ref="playbtn"
                                            className="btn btn-default btn-lg margin-right-btn play-btn"
                                            onClick={this.playPauseToggle}>
                                        <i className={"fa fa-" + (this.state.paused ? "play" : "pause")}
                                           aria-hidden="true" />
                                    </button>
                                    <button title="Skip Frame - Hotkey: ." type="button"
                                            className="btn btn-default btn-lg margin-right-btn"
                                            onClick={this.skipFrame}>
                                        <i className="fa fa-step-forward" aria-hidden="true" />
                                    </button>
                                    <button title="Restart Playback - Hotkey: Shift-R" type="button"
                                            className="btn btn-default btn-lg" onClick={this.rewindToStart}>
                                        <i className="fa fa-fast-backward" aria-hidden="true" />
                                    </button>
                                    <button title="Fast-forward to end - Hotkey: Shift-G" type="button"
                                            className="btn btn-default btn-lg margin-right-btn"
                                            onClick={this.fastForwardToEnd}>
                                        <i className="fa fa-fast-forward" aria-hidden="true" />
                                    </button>
                                    <button title="Speed /2 - Hotkey: {" type="button"
                                            className="btn btn-default btn-lg" onClick={this.speedDown}>
                                        /2
                                    </button>
                                    <button title="Reset Speed - Hotkey: Backspace" type="button"
                                            className="btn btn-default btn-lg" onClick={this.speedReset}>
                                        1:1
                                    </button>
                                    <button title="Speed x2 - Hotkey: }" type="button"
                                            className="btn btn-default btn-lg margin-right-btn"
                                            onClick={this.speedUp}>
                                        x2
                                    </button>
                                    <span>{speedStr}</span>
                                    <span style={to_right}>
                                        <span className="session_time">{formatDuration(this.state.currentTsPost)} / {formatDuration(this.buf.pos)}</span>
                                        <button title="Drag'n'Pan" type="button" className="btn btn-default btn-lg"
                                                onClick={this.dragPan}>
                                            <i className={"fa fa-" + (this.state.drag_pan ? "hand-rock-o" : "hand-paper-o")}
                                               aria-hidden="true" /></button>
                                        <button title="Zoom In - Hotkey: =" type="button" className="btn btn-default btn-lg"
                                                onClick={this.zoomIn} disabled={this.state.term_zoom_max}>
                                            <i className="fa fa-search-plus" aria-hidden="true" /></button>
                                        <button title="Fit To - Hotkey: Z" type="button" className="btn btn-default btn-lg"
                                                onClick={this.fitTo}><i className="fa fa-expand" aria-hidden="true" /></button>
                                        <button title="Zoom Out - Hotkey: -" type="button" className="btn btn-default btn-lg"
                                                onClick={this.zoomOut} disabled={this.state.term_zoom_min}>
                                            <i className="fa fa-search-minus" aria-hidden="true" /></button>
                                    </span>
                                    <div id="input-player-wrap">
                                        <InputPlayer input={this.state.input} />
                                    </div>
                                    <div>
                                        <Search matchList={this.props.matchList} fastForwardToTS={this.fastForwardToTS} play={this.play} pause={this.pause} paused={this.state.paused} errorService={this.error_service} />
                                    </div>
                                    <div className="clearfix" />
                                    <ErrorList list={this.error_service.errors} />
                                </div>
                            </div>
                        </div>
                    </div>
                    <div className="col-md-6">
                        <div className="panel panel-default">
                            <div className="panel-heading">
                                <span>{_("Recording")}</span>
                            </div>
                            <div className="panel-body">
                                <table className="form-table-ct">
                                    <tbody>
                                        <tr>
                                            <td>{_("ID")}</td>
                                            <td>{r.id}</td>
                                        </tr>
                                        <tr>
                                            <td>{_("Hostname")}</td>
                                            <td>{r.hostname}</td>
                                        </tr>
                                        <tr>
                                            <td>{_("Boot ID")}</td>
                                            <td>{r.boot_id}</td>
                                        </tr>
                                        <tr>
                                            <td>{_("Session ID")}</td>
                                            <td>{r.session_id}</td>
                                        </tr>
                                        <tr>
                                            <td>{_("PID")}</td>
                                            <td>{r.pid}</td>
                                        </tr>
                                        <tr>
                                            <td>{_("Start")}</td>
                                            <td>{formatDateTime(r.start)}</td>
                                        </tr>
                                        <tr>
                                            <td>{_("End")}</td>
                                            <td>{formatDateTime(r.end)}</td>
                                        </tr>
                                        <tr>
                                            <td>{_("Duration")}</td>
                                            <td>{formatDuration(r.end - r.start)}</td>
                                        </tr>
                                        <tr>
                                            <td>{_("User")}</td>
                                            <td>{r.user}</td>
                                        </tr>
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    </div>
                </div>
                <div className="row">
                    <div className="col-md-12">
                        <Logs recording={r.id} curTs={this.state.currentTsPost}
                              jumpToTs={this.handleLogTsChange} />
                    </div>
                </div>
            </React.Fragment>
        );
    }

    componentWillUnmount() {
        this.buf.stop();
        window.removeEventListener("keydown", this.handleKeyDown, false);
        this.state.term.destroy();
    }
}

/*
 * A component representing a date & time picker based on bootstrap-datetime-picker.
 * Requires jQuery, bootstrap-datetime-picker, moment.js
 * Properties:
 * - onChange: function to call on date change event of datepicker.
 * - value: variable to pass which will be used as initial value.
 */
class Datetimepicker extends React.Component {
    constructor(props) {
        super(props);
        this.handleDateChange = this.handleDateChange.bind(this);
        this.clearField = this.clearField.bind(this);
        this.state = {
            invalid: false,
            date: this.props.value,
        };
    }

    componentDidMount() {
        $(this.refs.datepicker).datetimepicker({
            format: 'yyyy-mm-dd hh:ii:00',
            autoclose: true,
            todayBtn: true,
        })
                .on('changeDate', this.handleDateChange);
        // remove datepicker from input, so it only works by button press
        $(this.refs.datepicker_input).datetimepicker('remove');
    }

    componentWillUnmount() {
        $(this.refs.datepicker).datetimepicker('remove');
    }

    handleDateChange() {
        const date = $(this.refs.datepicker_input).val()
                .trim();
        this.setState({invalid: false, date: date});
        if (!parseDate(date)) {
            this.setState({invalid: true});
        } else {
            this.props.onChange(date);
        }
    }

    clearField() {
        const date = "";
        this.props.onChange(date);
        this.setState({date: date, invalid: false});
        $(this.refs.datepicker_input).val("");
    }

    render() {
        return (
            <div ref="datepicker" className="input-group date input-append date form_datetime">
                <input ref="datepicker_input" type="text" size="16"
                    className={"form-control bootstrap-datepicker " + (this.state.invalid ? "invalid" : "valid")}
                    value={this.state.date} onChange={this.handleDateChange} />
                <span className="input-group-addon add-on"><i className="fa fa-calendar" /></span>
                <span className="input-group-addon add-on" onClick={this.clearField}>
                    <i className="fa fa-remove" /></span>
            </div>
        );
    }
}

function LogElement(props) {
    const entry = props.entry;
    const start = props.start;
    const end = props.end;
    const cursor = entry.__CURSOR;
    const entry_timestamp = parseInt(entry.__REALTIME_TIMESTAMP / 1000);

    const timeClick = function(e) {
        const ts = entry_timestamp - start;
        if (ts > 0) {
            props.jumpToTs(ts);
        } else {
            props.jumpToTs(0);
        }
    };
    const messageClick = () => {
        const url = '/system/logs#/' + cursor + '?parent_options={}';
        const win = window.open(url, '_blank');
        win.focus();
    };

    let className = 'cockpit-logline';
    if (start < entry_timestamp && end > entry_timestamp) {
        className = 'cockpit-logline highlighted';
    }

    return (
        <div className={className} data-cursor={cursor} key={cursor}>
            <div className="cockpit-log-warning">
                <i className="fa fa-exclamation-triangle" />
            </div>
            <div className="logs-view-log-time" onClick={timeClick}>{formatDateTime(entry_timestamp)}</div>
            <span className="cockpit-log-message" onClick={messageClick}>{entry.MESSAGE}</span>
        </div>
    );
}

function LogsView(props) {
    const entries = props.entries;
    const start = props.start;
    const end = props.end;
    const rows = entries.map((entry) =>
        <LogElement key={entry.__CURSOR} entry={entry} start={start} end={end} jumpToTs={props.jumpToTs} />
    );
    return (
        <div className="panel panel-default cockpit-log-panel" id="logs-view">
            {rows}
        </div>
    );
}

class Logs extends React.Component {
    constructor(props) {
        super(props);
        this.journalctlError = this.journalctlError.bind(this);
        this.journalctlIngest = this.journalctlIngest.bind(this);
        this.journalctlPrepend = this.journalctlPrepend.bind(this);
        this.getLogs = this.getLogs.bind(this);
        this.loadLater = this.loadLater.bind(this);
        this.loadForTs = this.loadForTs.bind(this);
        this.getServerTimeOffset = this.getServerTimeOffset.bind(this);
        this.journalCtl = null;
        this.entries = [];
        this.start = null;
        this.end = null;
        this.hostname = null;
        this.state = {
            serverTimeOffset: null,
            cursor: null,
            after: null,
            entries: [],
        };
    }

    getServerTimeOffset() {
        cockpit.spawn(["date", "+%s:%:z"], { err: "message" })
                .done((data) => {
                    this.setState({serverTimeOffset: data.slice(data.indexOf(":") + 1)});
                })
                .fail((ex) => {
                    console.log("Couldn't calculate server time offset: " + cockpit.message(ex));
                });
    }

    scrollToTop() {
        const logs_view = document.getElementById("logs-view");
        logs_view.scrollTop = 0;
    }

    scrollToBottom() {
        const logs_view = document.getElementById("logs-view");
        logs_view.scrollTop = logs_view.scrollHeight;
    }

    journalctlError(error) {
        console.warn(cockpit.message(error));
    }

    journalctlIngest(entryList) {
        if (entryList.length > 0) {
            this.entries.push(...entryList);
            const after = this.entries[this.entries.length - 1].__CURSOR;
            this.setState({entries: this.entries, after: after});
            this.scrollToBottom();
        }
    }

    journalctlPrepend(entryList) {
        entryList.push(...this.entries);
        this.setState({entries: this.entries});
    }

    getLogs() {
        if (this.start != null && this.end != null) {
            if (this.journalCtl != null) {
                this.journalCtl.stop();
                this.journalCtl = null;
            }

            let matches = [];
            if (this.hostname) {
                matches.push("_HOSTNAME=" + this.hostname);
            }

            let start = null;
            let end = null;

            if (this.state.serverTimeOffset != null) {
                start = formatDateTimeOffset(this.start, this.state.serverTimeOffset);
                end = formatDateTimeOffset(this.end, this.state.serverTimeOffset);
            } else {
                start = formatDateTime(this.start);
                end = formatDateTime(this.end);
            }

            let options = {
                since: start,
                until: end,
                follow: false,
                count: "all",
                merge: true,
            };

            if (this.state.after != null) {
                options["after"] = this.state.after;
                delete options.since;
            }

            const self = this;
            this.journalCtl = Journal.journalctl(matches, options)
                    .fail(this.journalctlError)
                    .done(function(data) {
                        self.journalctlIngest(data);
                    });
        }
    }

    loadLater() {
        this.start = this.end;
        this.end = this.end + 3600;
        this.getLogs();
    }

    loadForTs(ts) {
        this.end = this.start + ts;
        this.getLogs();
    }

    componentWillMount() {
        this.getServerTimeOffset();
    }

    componentDidUpdate() {
        if (this.props.recording) {
            if (this.start === null && this.end === null) {
                this.end = this.props.recording.start + 3600;
                this.start = this.props.recording.start;
            }
            if (this.props.recording.hostname) {
                this.hostname = this.props.recording.hostname;
            }
            this.getLogs();
        }
        if (this.props.curTs) {
            const ts = this.props.curTs;
            this.loadForTs(ts);
        }
    }

    componentWillUnmount() {
        this.journalCtl.stop();
        this.setState({
            serverTimeOffset: null,
            cursor: null,
            after: null,
            entries: [],
        });
    }

    render() {
        let r = this.props.recording;
        if (r === null || r === undefined) {
            return <span>Loading...</span>;
        } else {
            return (
                <div className="panel panel-default">
                    <div className="panel-heading">
                        <span>{_("Logs")}</span>
                        <button className="btn btn-default" style={{"float":"right"}} onClick={this.loadLater}>{_("Load later entries")}</button>
                    </div>
                    <LogsView entries={this.state.entries} start={this.props.recording.start}
                              end={this.props.recording.end} jumpToTs={this.props.jumpToTs} />
                    <div className="panel-heading" />
                </div>
            );
        }
    }
}

/*
 * A component representing a single recording view.
 * Properties:
 * - recording: either null for no recording data available yet, or a
 *              recording object, as created by the View below.
 */
class Recording extends React.Component {
    constructor(props) {
        super(props);
        this.goBackToList = this.goBackToList.bind(this);
    }

    goBackToList() {
        if (cockpit.location.path[0]) {
            if ("search_rec" in cockpit.location.options) {
                delete cockpit.location.options.search_rec;
            }
            cockpit.location.go([], cockpit.location.options);
        } else {
            cockpit.location.go('/');
        }
    }

    render() {
        let r = this.props.recording;
        if (r == null) {
            return <span>Loading...</span>;
        } else {
            let player =
                (<Player
                    ref="player"
                    matchList={this.props.recording.matchList}
                    logsTs={this.props.logsTs}
                    search={this.props.search}
                    onTsChange={this.props.onTsChange}
                    recording={r} />);

            return (
                <div className="container-fluid">
                    <div className="row">
                        <div className="col-md-12">
                            <ol className="breadcrumb">
                                <li><a onClick={this.goBackToList}>{_("Session Recording")}</a></li>
                                <li className="active">{_("Session")}</li>
                            </ol>
                        </div>
                    </div>
                    {player}
                </div>
            );
        }
    }
}

/*
 * A component representing a list of recordings.
 * Properties:
 * - list: an array with recording objects, as created by the View below
 */
class RecordingList extends React.Component {
    constructor(props) {
        super(props);
        this.handleColumnClick = this.handleColumnClick.bind(this);
        this.getSortedList = this.getSortedList.bind(this);
        this.drawSortDir = this.drawSortDir.bind(this);
        this.getColumnTitles = this.getColumnTitles.bind(this);
        this.getColumns = this.getColumns.bind(this);
        this.state = {
            sorting_field: "start",
            sorting_asc: true,
        };
    }

    drawSortDir() {
        $('#sort_arrow').remove();
        let type = this.state.sorting_asc ? "asc" : "desc";
        let arrow = '<i id="sort_arrow" class="fa fa-sort-' + type + '" aria-hidden="true" />';
        $(this.refs[this.state.sorting_field]).append(arrow);
    }

    handleColumnClick(event) {
        if (this.state.sorting_field === event.currentTarget.id) {
            this.setState({sorting_asc: !this.state.sorting_asc});
        } else {
            this.setState({
                sorting_field: event.currentTarget.id,
                sorting_asc: 'asc'
            });
        }
    }

    getSortedList() {
        let field = this.state.sorting_field;
        let asc = this.state.sorting_asc;
        let list = this.props.list.slice();

        if (this.state.sorting_field != null) {
            if (asc) {
                list.sort(function(a, b) {
                    return a[field] > b[field];
                });
            } else {
                list.sort(function(a, b) {
                    return a[field] < b[field];
                });
            }
        }

        return list;
    }

    /*
     * Set the cockpit location to point to the specified recording.
     */
    navigateToRecording(recording) {
        cockpit.location.go([recording.id], cockpit.location.options);
    }

    componentDidUpdate() {
        this.drawSortDir();
    }

    getColumnTitles() {
        let columnTitles = [
            (<div id="user" className="sort" onClick={this.handleColumnClick}><span>{_("User")}</span> <div
                ref="user" className="sort-icon" /></div>),
            (<div id="start" className="sort" onClick={this.handleColumnClick}><span>{_("Start")}</span> <div
                ref="start" className="sort-icon" /></div>),
            (<div id="end" className="sort" onClick={this.handleColumnClick}><span>{_("End")}</span> <div
                ref="end" className="sort-icon" /></div>),
            (<div id="duration" className="sort" onClick={this.handleColumnClick}><span>{_("Duration")}</span> <div
                ref="duration" className="sort-icon" /></div>),
        ];
        if (this.props.diff_hosts === true) {
            columnTitles.push((<div id="hostname" className="sort" onClick={this.handleColumnClick}>
                <span>{_("Hostname")}</span> <div ref="hostname" className="sort-icon" /></div>));
        }
        return columnTitles;
    }

    getColumns(r) {
        let columns = [r.user,
            formatDateTime(r.start),
            formatDateTime(r.end),
            formatDuration(r.end - r.start)];
        if (this.props.diff_hosts === true) {
            columns.push(r.hostname);
        }
        return columns;
    }

    render() {
        let columnTitles = this.getColumnTitles();
        let list = this.getSortedList();
        let rows = [];

        for (let i = 0; i < list.length; i++) {
            let r = list[i];
            let columns = this.getColumns(r);
            rows.push(<Listing.ListingRow
                        key={r.id}
                        rowId={r.id}
                        columns={columns}
                        navigateToItem={this.navigateToRecording.bind(this, r)} />);
        }
        return (
            <Listing.Listing title={_("Sessions")}
                             columnTitles={columnTitles}
                             emptyCaption={_("No recorded sessions")}
                             fullWidth={false}>
                {rows}
            </Listing.Listing>
        );
    }
}

/*
 * A component representing the view upon a list of recordings, or a
 * single recording. Extracts the ID of the recording to display from
 * cockpit.location.path[0]. If it's zero, displays the list.
 */
class View extends React.Component {
    constructor(props) {
        super(props);
        this.onLocationChanged = this.onLocationChanged.bind(this);
        this.journalctlIngest = this.journalctlIngest.bind(this);
        this.handleInputChange = this.handleInputChange.bind(this);
        this.handleTsChange = this.handleTsChange.bind(this);
        this.handleLogTsChange = this.handleLogTsChange.bind(this);
        this.handleDateSinceChange = this.handleDateSinceChange.bind(this);
        this.openConfig = this.openConfig.bind(this);
        /* Journalctl instance */
        this.journalctl = null;
        /* Recording ID journalctl instance is invoked with */
        this.journalctlRecordingID = null;
        /* Recording ID -> data map */
        this.recordingMap = {};
        /* tlog UID in system set in ComponentDidMount */
        this.uid = null;
        this.state = {
            /* List of recordings in start order */
            recordingList: [],
            /* ID of the recording to display, or null for all */
            recordingID: cockpit.location.path[0] || null,
            /* filter values start */
            date_since: cockpit.location.options.date_since || "",
            date_until: cockpit.location.options.date_until || "",
            username: cockpit.location.options.username || "",
            hostname: cockpit.location.options.hostname || "",
            search: cockpit.location.options.search || "",
            /* filter values end */
            error_tlog_uid: false,
            diff_hosts: false,
            curTs: null,
            logsTs: null,
        };
    }

    /*
     * Display a journalctl error
     */
    journalctlError(error) {
        console.warn(cockpit.message(error));
    }

    /*
     * Respond to cockpit location change by extracting and setting the
     * displayed recording ID.
     */
    onLocationChanged() {
        this.setState({
            recordingID: cockpit.location.path[0] || null,
            date_since: cockpit.location.options.date_since || "",
            date_until: cockpit.location.options.date_until || "",
            username: cockpit.location.options.username || "",
            hostname: cockpit.location.options.hostname || "",
            search: cockpit.location.options.search || "",
        });
    }

    /*
     * Ingest journal entries sent by journalctl.
     */
    journalctlIngest(entryList) {
        let recordingList = this.state.recordingList.slice();
        let i;
        let j;
        let hostname;

        if (entryList[0]) {
            if (entryList[0]["_HOSTNAME"]) {
                hostname = entryList[0]["_HOSTNAME"];
            }
        }

        for (i = 0; i < entryList.length; i++) {
            let e = entryList[i];
            let id = e['TLOG_REC'];

            /* Skip entries with missing recording ID */
            if (id === undefined) {
                continue;
            }

            let ts = Math.floor(
                parseInt(e["__REALTIME_TIMESTAMP"], 10) /
                            1000);

            let r = this.recordingMap[id];
            /* If no recording found */
            if (r === undefined) {
                /* Create new recording */
                if (hostname !== e["_HOSTNAME"]) {
                    this.setState({diff_hosts: true});
                }

                r = {id:            id,
                     matchList:     ["TLOG_REC=" + id],
                     user:          e["TLOG_USER"],
                     boot_id:       e["_BOOT_ID"],
                     session_id:    parseInt(e["TLOG_SESSION"], 10),
                     pid:           parseInt(e["_PID"], 10),
                     start:         ts,
                     /* FIXME Should be start + message duration */
                     end:       ts,
                     hostname:  e["_HOSTNAME"],
                     duration:  0};
                /* Map the recording */
                this.recordingMap[id] = r;
                /* Insert the recording in order */
                for (j = recordingList.length - 1;
                    j >= 0 && r.start < recordingList[j].start;
                    j--);
                recordingList.splice(j + 1, 0, r);
            } else {
                /* Adjust existing recording */
                if (ts > r.end) {
                    r.end = ts;
                    r.duration = r.end - r.start;
                }
                if (ts < r.start) {
                    r.start = ts;
                    r.duration = r.end - r.start;
                    /* Find the recording in the list */
                    for (j = recordingList.length - 1;
                        j >= 0 && recordingList[j] !== r;
                        j--);
                    /* If found */
                    if (j >= 0) {
                        /* Remove */
                        recordingList.splice(j, 1);
                    }
                    /* Insert the recording in order */
                    for (j = recordingList.length - 1;
                        j >= 0 && r.start < recordingList[j].start;
                        j--);
                    recordingList.splice(j + 1, 0, r);
                }
            }
        }

        this.setState({recordingList: recordingList});
    }

    /*
     * Start journalctl, retrieving entries for the current recording ID.
     * Assumes journalctl is not running.
     */
    journalctlStart() {
        let matches = ["_UID=" + this.uid, "+", "_EXE=/usr/bin/tlog-rec-session", "+", "_EXE=/usr/bin/tlog-rec", "+", "SYSLOG_IDENTIFIER=-tlog-rec-session"];
        if (this.state.username && this.state.username !== "") {
            matches.push("TLOG_USER=" + this.state.username);
        }
        if (this.state.hostname && this.state.hostname !== "") {
            matches.push("_HOSTNAME=" + this.state.hostname);
        }

        let options = {follow: true, count: "all", merge: true};

        if (this.state.date_since && this.state.date_since !== "") {
            options['since'] = this.state.date_since;
        }

        if (this.state.date_until && this.state.date_until !== "") {
            options['until'] = this.state.date_until;
        }

        if (this.state.search && this.state.search !== "" && this.state.recordingID === null) {
            options["grep"] = this.state.search;
        }

        if (this.state.recordingID !== null) {
            delete options["grep"];
            matches.push("TLOG_REC=" + this.state.recordingID);
        }

        this.journalctlRecordingID = this.state.recordingID;
        this.journalctl = Journal.journalctl(matches, options)
                .fail(this.journalctlError)
                .stream(this.journalctlIngest);
    }

    /*
     * Check if journalctl is running.
     */
    journalctlIsRunning() {
        return this.journalctl != null;
    }

    /*
     * Stop current journalctl.
     * Assumes journalctl is running.
     */
    journalctlStop() {
        this.journalctl.stop();
        this.journalctl = null;
    }

    /*
     * Restarts journalctl.
     * Will stop journalctl if it's running.
     */
    journalctlRestart() {
        if (this.journalctlIsRunning()) {
            this.journalctl.stop();
        }
        this.journalctlStart();
    }

    /*
     * Clears previous recordings list.
     * Will clear service obj recordingMap and state.
     */
    clearRecordings() {
        this.recordingMap = {};
        this.setState({recordingList: []});
    }

    handleInputChange(event) {
        const name = event.target.name;
        const value = event.target.value;
        let state = {};
        state[name] = value;
        this.setState(state);
        cockpit.location.go([], $.extend(cockpit.location.options, state));
    }

    handleDateSinceChange(date) {
        cockpit.location.go([], $.extend(cockpit.location.options, {date_since: date}));
    }

    handleDateUntilChange(date) {
        cockpit.location.go([], $.extend(cockpit.location.options, {date_until: date}));
    }

    handleTsChange(ts) {
        this.setState({curTs: ts});
    }

    handleLogTsChange(ts) {
        this.setState({logsTs: ts});
    }

    openConfig() {
        cockpit.jump(['session-recording/config']);
    }

    componentDidMount() {
        let proc = cockpit.spawn(["getent", "passwd", "tlog"]);

        proc.stream((data) => {
            this.uid = data.split(":", 3)[2];
            this.journalctlStart();
            proc.close();
        });

        proc.fail(() => {
            this.setState({error_tlog_uid: true});
        });

        cockpit.addEventListener("locationchanged",
                                 this.onLocationChanged);
    }

    componentWillUnmount() {
        if (this.journalctlIsRunning()) {
            this.journalctlStop();
        }
    }

    componentDidUpdate(prevProps, prevState) {
        /*
         * If we're running a specific (non-wildcard) journalctl
         * and recording ID has changed
         */
        if (this.journalctlRecordingID !== null &&
            this.state.recordingID !== prevState.recordingID) {
            if (this.journalctlIsRunning()) {
                this.journalctlStop();
            }
            this.journalctlStart();
        }
        if (this.state.date_since !== prevState.date_since ||
            this.state.date_until !== prevState.date_until ||
            this.state.username !== prevState.username ||
            this.state.hostname !== prevState.hostname ||
            this.state.search !== prevState.search
        ) {
            this.clearRecordings();
            this.journalctlRestart();
        }
    }

    render() {
        if (this.state.error_tlog_uid === true) {
            return (
                <div className="container-fluid">
                    Error getting tlog UID from system.
                </div>
            );
        }
        if (this.state.recordingID === null) {
            return (
                <React.Fragment>
                    <div className="content-header-extra">
                        <table className="form-table-ct">
                            <thead>
                                <tr>
                                    <td className="top">
                                        <label className="control-label" htmlFor="date_since">{_("Since")}</label>
                                    </td>
                                    <td>
                                        <Datetimepicker value={this.state.date_since} onChange={this.handleDateSinceChange} />
                                    </td>
                                    <td className="top">
                                        <label className="control-label" htmlFor="date_until">{_("Until")}</label>
                                    </td>
                                    <td>
                                        <Datetimepicker value={this.state.date_until} onChange={this.handleDateUntilChange} />
                                    </td>
                                    <td className="top">
                                        <label className="control-label" htmlFor="search">Search</label>
                                    </td>
                                    <td>
                                        <div className="input-group">
                                            <input type="text" className="form-control" name="search" value={this.state.search}
                                                   onChange={this.handleInputChange} />
                                        </div>
                                    </td>
                                    <td className="top">
                                        <label className="control-label" htmlFor="username">Username</label>
                                    </td>
                                    <td>
                                        <div className="input-group">
                                            <input type="text" className="form-control" name="username" value={this.state.username}
                                                   onChange={this.handleInputChange} />
                                        </div>
                                    </td>
                                    {this.state.diff_hosts === true &&
                                    <td className="top">
                                        <label className="control-label" htmlFor="hostname">{_("Hostname")}</label>
                                    </td>
                                    }
                                    {this.state.diff_hosts === true &&
                                    <td>
                                        <div className="input-group">
                                            <input type="text" className="form-control" name="hostname" value={this.state.hostname}
                                                   onChange={this.handleInputChange} />
                                        </div>
                                    </td>
                                    }
                                    <td className="top">
                                        <label className="control-label" htmlFor="config">{_("Configuration")}</label>
                                    </td>
                                    <td className="top">
                                        <button className="btn btn-default" onClick={this.openConfig}><i className="fa fa-cog" aria-hidden="true" /></button>
                                    </td>
                                </tr>
                            </thead>
                        </table>
                    </div>
                    <RecordingList
                        date_since={this.state.date_since}
                        date_until={this.state.date_until}
                        username={this.state.username}
                        hostname={this.state.hostname}
                        list={this.state.recordingList}
                        diff_hosts={this.state.diff_hosts} />
                </React.Fragment>
            );
        } else {
            return (
                <React.Fragment>
                    <Recording recording={this.recordingMap[this.state.recordingID]} search={this.state.search} />
                </React.Fragment>
            );
        }
    }
}

ReactDOM.render(<View />, document.getElementById('view'));
