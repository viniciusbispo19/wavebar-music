// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Vinicius Bispo
//
// Só para scripts fora do Shell: o GNOME Shell adiciona connectObject()/
// disconnectObject() a todo GObject (misc/signalTracker.js). Num `gjs` puro
// eles não existem, então recriamos uma versão mínima aqui.

import GObject from 'gi://GObject';

const handlers = new WeakMap(); // emissor → Map(dono → [ids])

if (!GObject.Object.prototype.connectObject) {
    GObject.Object.prototype.connectObject = function (...args) {
        const owner = args.pop();
        const ids = [];
        while (args.length) {
            const signal = args.shift();
            const handler = args.shift();
            if (typeof args[0] === 'number')
                args.shift(); // flags (não usadas aqui)
            ids.push(this.connect(signal, handler));
        }
        if (!handlers.has(this))
            handlers.set(this, new Map());
        const byOwner = handlers.get(this);
        byOwner.set(owner, [...byOwner.get(owner) ?? [], ...ids]);
    };

    GObject.Object.prototype.disconnectObject = function (owner) {
        const byOwner = handlers.get(this);
        byOwner?.get(owner)?.forEach(id => this.disconnect(id));
        byOwner?.delete(owner);
    };
}
