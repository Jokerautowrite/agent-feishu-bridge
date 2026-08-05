const emptyCodexProfiles = Object.freeze({
  displayNames: Object.freeze({}),
  profiles: Object.freeze({}),
  beforeSwitchCodexAppServerProfile: async () => {},
  getProfileHelpLines: () => [],
  getProfileNote: () => "",
});

module.exports = {
  codexProfiles: emptyCodexProfiles,
};
