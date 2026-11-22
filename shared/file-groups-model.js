(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.StudioFileGroups = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  class FileGroupsModel {
    constructor(initialState) {
      this.groups = []; // [{ id, name, collapsed }]
      this.assignments = {}; // itemKey -> groupId
      this._seq = 1;
      if (initialState) this.load(initialState);
    }

    load(data) {
      if (!data || typeof data !== 'object') return;
      this.groups = Array.isArray(data.groups)
        ? data.groups
            .filter((g) => g && g.id && g.name)
            .map((g) => ({ id: String(g.id), name: String(g.name), collapsed: Boolean(g.collapsed) }))
        : [];
      this.assignments =
        data.assignments && typeof data.assignments === 'object' ? { ...data.assignments } : {};
      const validIds = new Set(this.groups.map((g) => g.id));
      for (const [k, v] of Object.entries(this.assignments)) {
        if (!validIds.has(v)) delete this.assignments[k];
      }
      this._seq = Math.max(this._seq, this.groups.length + 1);
    }

    serialize() {
      return {
        groups: this.groups.map((g) => ({ ...g })),
        assignments: { ...this.assignments }
      };
    }

    createGroup(name) {
      const clean = String(name || '').trim();
      if (!clean) return null;
      const id = `grp-${Date.now().toString(36)}-${this._seq++}`;
      const group = { id, name: clean, collapsed: false };
      this.groups.push(group);
      return group;
    }

    renameGroup(groupId, newName) {
      const clean = String(newName || '').trim();
      const group = this.groups.find((g) => g.id === groupId);
      if (!group || !clean) return false;
      group.name = clean;
      return true;
    }

    deleteGroup(groupId) {
      const idx = this.groups.findIndex((g) => g.id === groupId);
      if (idx === -1) return false;
      this.groups.splice(idx, 1);
      for (const [k, v] of Object.entries(this.assignments)) {
        if (v === groupId) delete this.assignments[k];
      }
      return true;
    }

    toggleCollapsed(groupId) {
      const group = this.groups.find((g) => g.id === groupId);
      if (!group) return false;
      group.collapsed = !group.collapsed;
      return group.collapsed;
    }

    assignItem(itemKey, groupId) {
      if (!itemKey) return false;
      if (!groupId) {
        delete this.assignments[itemKey];
        return true;
      }
      if (!this.groups.some((g) => g.id === groupId)) return false;
      this.assignments[itemKey] = groupId;
      return true;
    }

    getGroupIdFor(itemKey) {
      return this.assignments[itemKey] || null;
    }

    partition(items, keyFn = (it) => it.key || it.id) {
      const buckets = new Map();
      for (const g of this.groups) buckets.set(g.id, []);
      const ungrouped = [];

      for (const item of items || []) {
        const key = keyFn(item);
        const gid = this.assignments[key];
        if (gid && buckets.has(gid)) buckets.get(gid).push(item);
        else ungrouped.push(item);
      }

      return {
        groups: this.groups.map((g) => ({ ...g, items: buckets.get(g.id) || [] })),
        ungrouped
      };
    }
  }

  return { FileGroupsModel };
});
