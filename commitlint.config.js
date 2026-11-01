module.exports = {
  extends: ['@commitlint/config-conventional'],
  rules: {
    // release-please writes changelog bodies with long lines and links
    'body-max-line-length': [0],
    'footer-max-line-length': [0],
  },
};
