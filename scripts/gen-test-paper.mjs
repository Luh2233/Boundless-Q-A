// 生成一份用于测试的两页英文"迷你论文" PDF（无第三方依赖，手写 PDF 语法）
// 用法：node scripts/gen-test-paper.mjs  → 输出 test-paper.pdf
import fs from 'node:fs'
import path from 'node:path'

const PAGE_W = 612, PAGE_H = 792, MARGIN = 56, LEAD = 15.5, FONT = 11

const page1 = [
  ['title', 'Understanding Diffusion Models: A Minimal Reading Guide'],
  ['sub', 'Abstract'],
  ['body', 'Diffusion models learn to generate data by gradually reversing a fixed noising process. Starting from pure Gaussian noise, a neural network is trained to predict the noise added at each step, so that sampling becomes an iterative denoising procedure. This note summarizes the core ideas for a first reading.'],
  ['sub', '1. The Forward Process'],
  ['body', 'The forward process is a Markov chain that corrupts an image x0 over T steps with a variance schedule. At each step, Gaussian noise is added according to q(xt | xt-1) = N(xt; sqrt(1 - beta_t) * xt-1, beta_t I). A key algebraic property is that any intermediate step can be sampled in closed form using the cumulative products alpha_t, which makes training efficient because the model never needs to simulate the full chain.'],
  ['body', 'The noise schedule beta_t is typically small early and larger later. Choosing this schedule is a bias-variance trade-off: too aggressive a schedule destroys semantic structure before the network can learn it, while too conservative a schedule wastes computation.'],
  ['sub', '2. The Reverse Process and Training Objective'],
  ['body', 'The reverse process is also modeled as Gaussian, but its mean is produced by a U-Net epsilon_theta. Ho et al. (2020) showed that predicting the noise itself, rather than the mean, yields a simplified loss: L_simple = E || epsilon - epsilon_theta(xt, t) ||^2. This reweighting behaves like a form of denoising score matching and is the de facto standard objective.'],
]

const page2 = [
  ['sub', '3. Connection to Score Matching'],
  ['body', 'Song and Ermon connected diffusion to score-based generative modeling: the score function grad log p(x) can be estimated by the same denoiser, and annealed Langevin dynamics recover samples. This viewpoint explains why the noise levels act as a temperature ladder covering different scales of the data distribution.'],
  ['sub', '4. Practical Notes for Readers'],
  ['body', 'When reading papers in this family, keep three quantities apart: the closed-form posterior q(xt-1 | xt, x0), the learned reverse kernel p_theta(xt-1 | xt), and the evidence lower bound (ELBO) used for variational interpretation. Most derivations are algebraic manipulations of these three objects plus the Gaussian KL divergence.'],
  ['body', 'For a first pass, focus on the simplified objective and the sampling algorithm; the full ELBO decomposition can be deferred. The essential skill is translating between the continuous-time SDE formulation and the discrete-time Markov chain, since recent papers freely switch between the two notations.'],
]

function esc(s) {
  return s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
}

function pageStream(items) {
  let y = PAGE_H - MARGIN
  let out = 'BT\n'
  for (const [kind, text] of items) {
    if (kind === 'title') { out += `/F1 16 Tf 1 0 0 1 ${MARGIN} ${y} Tm (${esc(text)}) Tj\n`; y -= 30 }
    else if (kind === 'sub') { out += `/F1 ${FONT + 1} Tf 1 0 0 1 ${MARGIN} ${y} Tm (${esc(text)}) Tj\n`; y -= LEAD + 4 }
    else {
      // 简易自动换行（按 88 字符宽度近似）
      const words = text.split(' ')
      let line = ''
      const flush = () => { out += `/F1 ${FONT} Tf 1 0 0 1 ${MARGIN} ${y} Tm (${esc(line)}) Tj\n`; y -= LEAD }
      for (const w of words) {
        if ((line + ' ' + w).trim().length > 88) { flush(); line = w }
        else line = (line ? line + ' ' : '') + w
      }
      if (line) flush()
      y -= 6
    }
  }
  out += 'ET\n'
  return out
}

const objs = []
const add = body => { objs.push(body); return objs.length } // 返回对象号

const content1 = pageStream(page1)
const content2 = pageStream(page2)

// 顺序构造：1 Catalog, 2 Pages, 3 Font, 4/6 Page, 5/7 Contents
objs.push(null) // 占位 1
objs.push(null) // 占位 2
const fontNum = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
const page1Num = add(null)
const c1Num = add(`<< /Length ${content1.length} >>\nstream\n${content1}endstream`)
const page2Num = add(null)
const c2Num = add(`<< /Length ${content2.length} >>\nstream\n${content2}endstream`)

objs[0] = `<< /Type /Catalog /Pages 2 0 R >>`
objs[1] = `<< /Type /Pages /Kids [${page1Num} 0 R ${page2Num} 0 R] /Count 2 >>`
objs[page1Num - 1] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 ${fontNum} 0 R >> >> /Contents ${c1Num} 0 R >>`
objs[page2Num - 1] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 ${fontNum} 0 R >> >> /Contents ${c2Num} 0 R >>`

let pdf = '%PDF-1.4\n'
const offsets = []
objs.forEach((body, i) => {
  offsets.push(pdf.length)
  pdf += `${i + 1} 0 obj\n${body}\nendobj\n`
})
const xref = pdf.length
pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`
for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`
pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`

const out = path.resolve(process.cwd(), 'test-paper.pdf')
fs.writeFileSync(out, pdf, 'binary')
console.log('written:', out, pdf.length, 'bytes')
