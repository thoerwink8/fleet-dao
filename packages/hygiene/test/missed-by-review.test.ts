// PR #21 第一版审查时造的 29 条真泄漏里漏掉的 14 条（审查官的样本清单，值换成固定种子的伪随机串）。
// 这个文件只用 findHits：拿去对着第一版的规则跑是红的（先红），现在是绿的（后绿）。
// L16–L19（账号/组织编号）、L27（公网 IPv6）原本靠标识类规则拦，创始人 2026-09-28 傍晚拍：这类标识不再算泄漏，
// 规则已删（specs/169-Fusion形态/需求.md），这几条从清单里退役。
import { describe, expect, it } from 'vitest';
import { findHits } from '../src/rules.ts';
import { pseudoNumber, pseudoRandom } from './helpers.ts';

const R = (n: number, seed: number) => pseudoRandom(n, seed);

describe('第一版漏掉的 14 条，现在都拦得住', () => {
  it.each([
    ['L4 飞书 app secret，env 小写', `feishu_app_secret=${R(32, 102)}`],
    ['L6 飞书 app secret，命令行参数', `lark-cli config init --app-secret ${R(32, 103)}`],
    ['L7 飞书 app secret，Markdown 表格', `| app_secret | ${R(32, 104)} |`],
    ['L9 飞书 app secret，键名是 APP_KEY', `FEISHU_APP_KEY=${R(32, 105)}`],
    [
      'L10 AWS credentials 文件写法',
      `aws_secret_access_key = ${pseudoRandom(40, 106, `${'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'}+/`)}`,
    ],
    ['L11 短密码（12 位带符号）', `db_password: ${R(9, 107)}#$%`],
    ['L23 Bearer 不透明令牌', `Authorization: ${['Bearer', R(40, 108)].join(' ')}`],
    ['L24 Telegram 机器人令牌', `bot ${['6' + pseudoNumber(8, 109), `AA${R(33, 110)}`].join(':')}`],
    [
      'L26 Slack webhook 地址',
      [
        'https://hooks.slack.com/services',
        `T${R(8, 111).toUpperCase()}`,
        `B${R(8, 112).toUpperCase()}`,
        R(24, 113),
      ].join('/'),
    ],
  ])('%s', (_name, sample) => {
    expect(findHits(sample).length).toBeGreaterThan(0);
  });
});
