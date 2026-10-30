//! Small deterministic RNG (xorshift64*) for RANSAC sampling and tests, so
//! results are reproducible and no extra crates are needed.

use nalgebra::Vector3;

pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Self {
        Self(seed.max(1))
    }

    pub fn uniform(&mut self) -> f64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        let bits = self.0.wrapping_mul(0x2545_F491_4F6C_DD1D) >> 11;
        bits as f64 / (1u64 << 53) as f64
    }

    pub fn range(&mut self, lo: f64, hi: f64) -> f64 {
        lo + (hi - lo) * self.uniform()
    }

    /// Standard normal (Box–Muller).
    pub fn normal(&mut self) -> f64 {
        let u = self.uniform().max(1e-300);
        let v = self.uniform();
        (-2.0 * u.ln()).sqrt() * (std::f64::consts::TAU * v).cos()
    }

    pub fn normal3(&mut self, sigma: f64) -> Vector3<f64> {
        Vector3::new(self.normal(), self.normal(), self.normal()) * sigma
    }
}

impl Rng {
    /// `k` distinct indices from `0..n` (k ≤ n).
    pub fn sample(&mut self, n: usize, k: usize) -> Vec<usize> {
        let mut out: Vec<usize> = Vec::with_capacity(k);
        while out.len() < k {
            let i = ((self.uniform() * n as f64) as usize).min(n - 1);
            if !out.contains(&i) {
                out.push(i);
            }
        }
        out
    }
}
